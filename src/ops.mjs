// Relay operations shared by the MCP server, the CLI and background jobs.
import path from 'node:path';
import { ENV, fmtTime, fmtIn } from './core/util.mjs';
import { loadConfig } from './core/config.mjs';
import { AGENTS, LABEL, resolveAgent, runAgent, depth } from './core/agents.mjs';
import { limitedUntil, parseResetTime, codexUsage } from './core/limits.mjs';
import { acquireSlot } from './core/jobs.mjs';
import { createTicket, writeBaton, ensureWaker, stepTicket, getTicket, listTickets, describeTicket, wakerRunning } from './relay.mjs';

const label = (a) => LABEL[a] || a;

/** Which agent is calling us? The installer sets AI_AGENT_SELF per client. */
export function detectCaller() {
  const e = process.env;
  if (e[ENV.SELF]) return e[ENV.SELF];
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (e.GEMINI_CLI) return 'gemini';
  return null;
}

export function guard() {
  const max = loadConfig().max_depth;
  if (depth() >= max) {
    throw new Error(`Depth limit reached (${depth()}/${max}): you were started by another agent, so you cannot start more agents.`);
  }
}

/** Run one leg of a relay: a single agent, headless. Executed inside a background job. */
export async function ask(p, ctx = {}) {
  guard();
  const agent = p.agent;
  if (!resolveAgent(agent)) return { ok: false, agent, error: `${label(agent)} is not installed.` };
  const lu = limitedUntil(agent);
  if (lu) return { ok: false, agent, error: `${label(agent)} is usage-limited until ${fmtTime(lu)}`, limited_until: lu };
  const release = acquireSlot();
  try {
    return await runAgent(agent, {
      prompt: p.prompt, cwd: p.cwd, access: p.access || 'write', session: p.session_id, timeoutSec: p.timeout_sec,
      caller: 'Relay', log: ctx.log, signal: ctx.signal, onSpawn: ctx.onSpawn,
    });
  } finally {
    release();
  }
}

/**
 * Hand a task to another agent through a baton file, and arrange for the caller
 * to be woken up afterwards to review the work.
 */
export function handoff(p) {
  guard();
  const cwd = path.resolve(p.cwd || process.cwd());
  const from = p.from || detectCaller() || 'claude';
  const to = p.to && p.to !== 'auto' ? p.to : null;
  if (to && !AGENTS.includes(to)) return { ok: false, error: `Unknown agent "${to}". Use claude, codex or gemini.` };
  if (!p.baton?.trim() && !p.task?.trim()) return { ok: false, error: 'Provide a baton (handoff notes) or at least a task.' };
  const session = p.from_session_id || (from === 'claude' ? process.env.CLAUDE_CODE_SESSION_ID : null) || null;
  const resetAt = p.reset_at ? Date.parse(p.reset_at) || parseResetTime(`resets ${p.reset_at}`) : limitedUntil(from);
  const resume = p.resume || (resetAt ? 'after_reset' : 'on_next_message');
  const baton = p.baton?.trim() || `# Relay baton\n\n## Task\n${p.task}`;
  const batonPath = writeBaton(cwd, baton, { from: label(from), reason: 'handoff' });
  const chain = [...new Set([to, ...loadConfig().fallback_chain].filter((a) => a && a !== from))];
  const t = createTicket({
    origin: 'handoff', cwd, task: p.task || null, baton_path: batonPath,
    primary: { agent: from, session_id: session },
    access: p.access || 'write', chain, resume, fallback_first: true,
    limits: resetAt ? { [from]: resetAt } : {},
  });
  stepTicket(t);
  ensureWaker();
  const leg = getTicket(t.id).legs[0];
  const back = {
    after_reset: `${label(from)} will be resumed ${resetAt ? fmtIn(resetAt) : 'when its limit resets'} to review the work`,
    after_handoff: `${label(from)} will be resumed automatically to review when ${leg ? label(leg.agent) : 'the partner'} finishes`,
    on_next_message: `the report will be added to ${label(from)}'s session on the user's next message`,
    never: `${label(from)} will not be resumed`,
  }[resume];
  return {
    ok: !!leg,
    ticket_id: t.id,
    baton_path: batonPath,
    partner: leg?.agent || null,
    message: leg
      ? `${label(leg.agent)} is now working on it. Baton: ${batonPath}. Afterwards ${back}.`
      : `No partner agent is available right now (all limited or not installed). Relay will start one as soon as possible.`,
  };
}

/** Autopilot: run a task with automatic failover across a chain of agents. */
export function autopilot(p) {
  const cwd = path.resolve(p.cwd || process.cwd());
  const chain = (p.chain?.length ? p.chain : ['claude', 'codex', 'gemini']).filter((a) => resolveAgent(a));
  if (!chain.length) return { ok: false, error: 'None of the chain agents are installed.' };
  const primary = chain.find((a) => !limitedUntil(a)) || chain[0];
  const batonPath = writeBaton(cwd, `# Relay baton\n\n## Task\n${p.task}\n\n## Progress\n(nothing yet)`, { from: 'autopilot' });
  const t = createTicket({
    origin: 'run', cwd, task: p.task, baton_path: batonPath, primary: { agent: primary, session_id: null },
    access: p.access || 'write', chain: chain.filter((a) => a !== primary), resume: 'after_reset',
  });
  stepTicket(t);
  ensureWaker();
  return { ok: true, ticket_id: t.id, primary, baton_path: batonPath };
}

export function status() {
  const cu = codexUsage();
  return {
    caller: detectCaller(),
    agents: AGENTS.map((a) => {
      const lu = limitedUntil(a);
      const info = { agent: a, installed: !!resolveAgent(a), path: resolveAgent(a)?.path || null, limited_until: lu || null };
      if (a === 'codex' && cu) {
        info.usage = `5h ${cu.primary?.used_percent ?? '?'}% (resets ${fmtTime(cu.primary?.resets_at)}) · week ${cu.secondary?.used_percent ?? '?'}% (resets ${fmtTime(cu.secondary?.resets_at)})`;
      }
      return info;
    }),
    waker: wakerRunning() ? 'running' : 'idle',
    relays: listTickets().filter((t) => t.state === 'active' || Date.now() - t.updated_at < 6 * 3600e3).slice(0, 10).map(describeTicket),
  };
}

export const OPS = { ask };
