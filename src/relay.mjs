// Relay: when an agent hits its usage limit, hand the task to another agent,
// then wake the original back up when its limit resets so it can review + finish.
//
// A relay "ticket" is a small state machine on disk (~/.relay/tickets/<id>.json).
// The detached waker process steps every active ticket every 15s. Each step either
// waits, starts a leg (an agent run as a background job), or finishes the ticket.
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_HOME, ensureDir, readJSON, writeJSON, newId, pidAlive, spawnDetached, sleep, truncate,
  fmtTime, fmtIn, notify, event, gitInfo, appendLog,
} from './core/util.mjs';
import { loadConfig } from './core/config.mjs';
import { LABEL, AGENTS, resolveAgent, depth } from './core/agents.mjs';
import { limitedUntil, markLimited, parseResetTime, classifyFailure } from './core/limits.mjs';
import { startJob, getJob, cancelJob, isTerminal } from './core/jobs.mjs';

const DIR = path.join(APP_HOME, 'tickets');
const WAKER_PID = path.join(APP_HOME, 'waker.pid');
const WAKER_LOG = path.join(APP_HOME, 'waker.log');
const tfile = (id) => path.join(DIR, `${id}.json`);
const label = (a) => LABEL[a] || a;

export function getTicket(id) { return readJSON(tfile(id)); }
export function saveTicket(t) { t.updated_at = Date.now(); writeJSON(tfile(t.id), t); return t; }

export function listTickets({ active } = {}) {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch {}
  const all = files.map((f) => readJSON(path.join(DIR, f))).filter(Boolean).sort((a, b) => b.created_at - a.created_at);
  return active ? all.filter((t) => t.state === 'active') : all;
}

const log = (t, msg) => {
  t.log = [...(t.log || []), `${new Date().toLocaleTimeString()} ${msg}`].slice(-40);
  appendLog(WAKER_LOG, `[${t.id}] ${msg}`);
};

export function accessFromPermissionMode(mode) {
  if (mode === 'bypassPermissions') return 'full';
  if (mode === 'acceptEdits' || mode === 'auto') return 'write';
  if (mode === 'plan') return 'read';
  return loadConfig().default_access;
}

// ---- Baton (the handoff note every agent reads and appends to) ------------

function batonDir(cwd) {
  const d = path.join(cwd, '.relay');
  try {
    ensureDir(d);
    const gi = path.join(d, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    return d;
  } catch {
    return ensureDir(path.join(APP_HOME, 'batons', Buffer.from(cwd).toString('base64url').slice(-40)));
  }
}

export function writeBaton(cwd, markdown, { from, reason } = {}) {
  const dir = batonDir(cwd);
  const file = path.join(dir, 'baton.md');
  if (fs.existsSync(file)) {
    ensureDir(path.join(dir, 'history'));
    fs.copyFileSync(file, path.join(dir, 'history', `baton-${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
  }
  const g = gitInfo(cwd);
  const header = `<!-- relay baton · written ${new Date().toISOString()}${from ? ` · from ${from}` : ''}${reason ? ` · ${reason}` : ''} -->\n`;
  const repo = g ? `\n\n## Repo state (auto)\nBranch \`${g.branch}\` · HEAD ${g.head}\n\`\`\`\n${g.status || '(clean)'}\n\`\`\`\n${g.diffStat ? `\`\`\`\n${g.diffStat}\n\`\`\`\n` : ''}` : '';
  fs.writeFileSync(file, `${header}${markdown.trim()}${repo}\n`);
  return file;
}

export function appendBaton(file, title, body) {
  try { fs.appendFileSync(file, `\n\n## ${title}\n${String(body || '(no report)').trim()}\n`); } catch {}
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

const isNoise = (s) => !s.trim() || /^<(command-|local-command|system-reminder|bash-|task-notification)/.test(s.trim()) || s.startsWith('Caveat:');

/** Build a baton mechanically from a Claude Code transcript (no LLM needed). */
export function batonFromClaudeTranscript(transcriptPath, { cwd, sessionId, reason } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); } catch {}
  const users = [];
  const assistant = [];
  const files = new Map();
  const cmds = [];
  let todos = null;
  for (const l of lines) {
    if (!l) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.isSidechain) continue;
    if (j.type === 'user' && !j.isMeta) {
      const t = textOf(j.message?.content);
      if (t && !isNoise(t)) users.push(t);
    } else if (j.type === 'attachment' && j.attachment?.type === 'queued_command' && j.attachment.origin?.kind === 'human') {
      if (j.attachment.prompt && !isNoise(j.attachment.prompt)) users.push(j.attachment.prompt);
    } else if (j.type === 'assistant') {
      for (const c of j.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) assistant.push(c.text.trim());
        if (c.type !== 'tool_use') continue;
        const inp = c.input || {};
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) && inp.file_path) files.set(inp.file_path, c.name);
        if ((c.name === 'Bash' || c.name === 'PowerShell') && inp.command) cmds.push(inp.command);
        if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) todos = inp.todos;
      }
    }
  }
  const uniqUsers = [...new Set(users)];
  const first = uniqUsers[0] || '(original request not found in transcript)';
  const later = uniqUsers.slice(1).slice(-5);
  const md = [
    `# Relay baton — ${path.basename(cwd || '') || 'task'}`,
    `Handed off by **Claude** ${reason ? `because: ${reason}` : ''}`.trim(),
    `Session \`${sessionId || '?'}\` · full transcript: \`${transcriptPath}\``,
    '',
    '## Original request',
    truncate(first, 3000),
    later.length ? `\n## Follow-up requests from the user (oldest → newest)\n${later.map((u) => `- ${truncate(u, 1200).replace(/\n/g, '\n  ')}`).join('\n')}` : '',
    todos ? `\n## Todo list at handoff\n${todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')}` : '',
    '\n## Where Claude left off (its last messages, newest last)',
    assistant.slice(-4).map((a) => `> ${truncate(a, 1500).replace(/\n/g, '\n> ')}`).join('\n\n') || '(none)',
    files.size ? `\n## Files Claude created or edited\n${[...files.keys()].slice(-40).map((f) => `- ${f}`).join('\n')}` : '',
    cmds.length ? `\n## Recent shell commands\n\`\`\`\n${cmds.slice(-10).map((c) => truncate(c, 300)).join('\n')}\n\`\`\`` : '',
    '\n## Instructions for the next agent',
    '1. Read this baton fully. Skim the transcript only if something here is unclear.',
    '2. Check the current state of the files listed above before changing anything; Claude may have been mid-edit.',
    '3. Continue the task from where it stopped. Do not redo finished work; verify it instead.',
    '4. Keep the project in a working state, and run tests/builds if the project has them.',
    '5. When you stop (done or out of quota), append a "Report" section to this file: what you did, what is left, anything risky.',
  ].filter((x) => x !== '').join('\n');
  return md;
}

// ---- Tickets ----------------------------------------------------------------

export function createTicket(fields) {
  const cfg = loadConfig();
  const t = {
    id: newId('relay'),
    created_at: Date.now(),
    state: 'active',
    resume: 'after_reset',
    chain: cfg.fallback_chain,
    access: cfg.default_access,
    limits: {},
    legs: [],
    fallback_done: false,
    reported: false,
    ...fields,
  };
  t.chain = (t.chain || []).filter((a) => a !== t.primary.agent && AGENTS.includes(a));
  log(t, `created (${t.origin}) for ${label(t.primary.agent)} in ${t.cwd}`);
  return saveTicket(t);
}

const primaryReady = (t, now) => now >= (t.limits[t.primary.agent] || 0) + loadConfig().resume_buffer_sec * 1000
  && !limitedUntil(t.primary.agent) && !!resolveAgent(t.primary.agent);

function reportsSoFar(t) {
  return t.legs.filter((l) => l.kind === 'fallback' && l.summary)
    .map((l) => `### ${label(l.agent)} (${l.status})\n${truncate(l.summary, 5000)}`).join('\n\n');
}

function readBaton(t) {
  try { return truncate(fs.readFileSync(t.baton_path, 'utf8'), 20000); } catch { return ''; }
}

function fallbackPrompt(t, agent) {
  const prior = reportsSoFar(t);
  return [
    `You are taking over an in-progress task from ${label(t.primary.agent)} (another AI coding agent), which is paused${t.limits[t.primary.agent] ? ` until about ${fmtTime(t.limits[t.primary.agent])} because it hit its usage limit` : ''}.`,
    `Working directory: ${t.cwd}`,
    `The handoff baton is at ${t.baton_path}. Its current contents:`,
    '<baton>', readBaton(t), '</baton>',
    prior ? `\nOther agents already took a turn while ${label(t.primary.agent)} was paused:\n${prior}` : '',
    '',
    `Your job: do the remaining work of the overall task, exactly as ${label(t.primary.agent)} would have on its next turn.`,
    'Instructions such as "do only step 1 now" or "stop here" were addressed to that earlier turn, not to you. Still respect the',
    "user's real constraints. If the user clearly wanted to review or approve something before work continued, stop and report instead.",
    'Verify finished work instead of redoing it. Keep the project in a working state.',
    `When you stop (finished, blocked, or out of quota), append a section titled "Report from ${label(agent)}" to ${t.baton_path}`,
    'covering: what you did, files changed, what is left, and anything risky. Make your final message that same report.',
  ].filter((x) => x !== '').join('\n');
}

function resumePrompt(t) {
  const prior = reportsSoFar(t);
  if (t.primary.session_id) {
    return [
      prior
        ? `[Relay] You're back: your usage limit has reset. While you were paused, ${t.legs.filter((l) => l.kind === 'fallback').map((l) => label(l.agent)).join(' then ')} continued this task from the baton at ${t.baton_path}. Their reports:\n\n${prior}`
        : '[Relay] Your usage limit has reset. Continue exactly where you left off.',
      '',
      prior ? 'Now: (1) inspect what actually changed (git status / git diff), (2) review that work critically and fix anything wrong or incomplete, (3) finish the original task. ' : '',
      'There is no human watching this run, so do not ask questions; make sensible decisions. End with a short summary of what you did and what remains.',
    ].filter(Boolean).join('\n');
  }
  return [
    t.task ? `TASK:\n${t.task}` : 'Continue the task described in the baton below.',
    `\nWorking directory: ${t.cwd}. Shared handoff notes: ${t.baton_path}`,
    readBaton(t) ? `<baton>\n${readBaton(t)}\n</baton>` : '',
    prior ? `\nOther agents already worked on this; review their work critically before continuing:\n${prior}` : '',
    `\nWhen you stop, append a "Report from ${label(t.primary.agent)}" section to ${t.baton_path} and make your final message that report.`,
  ].filter(Boolean).join('\n');
}

function startLeg(t, agent, kind) {
  const prompt = kind === 'fallback' ? fallbackPrompt(t, agent) : resumePrompt(t);
  const session = kind === 'fallback' ? null : t.primary.session_id;
  const job = startJob('ask', { agent, prompt, cwd: t.cwd, access: t.access, session_id: session, from: 'relay', timeout_sec: 4 * 3600 },
    { title: `relay ${kind}: ${label(agent)}`, caller: 'relay' });
  t.legs.push({ agent, kind, job_id: job.id, status: 'running', started_at: Date.now() });
  log(t, `▶ ${kind} leg: ${label(agent)} (job ${job.id}, access ${t.access})`);
  if (kind === 'fallback') {
    notify('Relay', `${label(t.primary.agent)} is out of usage. ${label(agent)} is taking over in ${path.basename(t.cwd)}${t.limits[t.primary.agent] ? `; ${label(t.primary.agent)} returns ${fmtIn(t.limits[t.primary.agent])}` : ''}.`);
  } else {
    notify('Relay', `${label(agent)} is back${t.fallback_done ? ' and reviewing the handoff' : ''} in ${path.basename(t.cwd)}.`);
  }
}

/** Advance one ticket. Safe to call repeatedly. */
export function stepTicket(t) {
  if (t.state !== 'active') return t;
  const cfg = loadConfig();
  const now = Date.now();
  const cur = t.legs.at(-1);

  if (cur?.status === 'running') {
    const j = getJob(cur.job_id);
    if (j && !isTerminal(j)) {
      if (cur.kind === 'fallback' && t.resume === 'after_reset' && cfg.on_reset === 'takeover' && primaryReady(t, now)) {
        cancelJob(cur.job_id);
        cur.status = 'preempted';
        cur.ended_at = now;
        log(t, `${label(cur.agent)} preempted: ${label(t.primary.agent)} is back`);
      } else return saveTicket(t);
    } else {
      const r = j?.result || {};
      cur.ended_at = now;
      cur.status = !j ? 'lost' : r.limited_until ? 'limited' : j.status;
      cur.summary = truncate(r.answer || j?.error || '', 8000);
      if (r.session_id) cur.session_id = r.session_id;
      if (r.limited_until) t.limits[cur.agent] = r.limited_until;
      if (r.transient) t.limits[cur.agent] = now + cfg.transient_retry_min * 60e3;
      log(t, `■ ${label(cur.agent)} ${cur.kind} leg ended: ${cur.status}${r.limited_until ? ` (limited until ${fmtTime(r.limited_until)})` : ''}`);
      if (cur.kind === 'fallback' && cur.status === 'done') {
        t.fallback_done = true;
        appendBaton(t.baton_path, `Relay log: ${label(cur.agent)} finished its turn (${new Date().toLocaleString()})`, truncate(cur.summary, 3000));
        notify('Relay', `${label(cur.agent)} finished its turn on ${path.basename(t.cwd)}.`);
      }
      if (cur.kind !== 'fallback') {
        if (r.session_id) t.primary.session_id = r.session_id;
        if (cur.status === 'done') {
          t.state = 'done';
          log(t, `✔ ${label(t.primary.agent)} finished the task`);
          notify('Relay', `${label(t.primary.agent)} finished the task in ${path.basename(t.cwd)}.`);
          return saveTicket(t);
        }
        if (cur.status === 'failed' && !r.limited_until && !r.transient) {
          t.resume_failures = (t.resume_failures || 0) + 1;
          if (t.primary.session_id && /session|conversation|not found|no such/i.test(cur.summary)) {
            log(t, 'resume failed on the session; next attempt starts fresh from the baton');
            t.primary.session_id = null;
          }
          if (t.resume_failures >= 3) {
            t.state = 'failed';
            notify('Relay', `Couldn't resume ${label(t.primary.agent)} in ${path.basename(t.cwd)}. See: relay list`);
            return saveTicket(t);
          }
        }
      }
    }
  }

  if (t.legs.length >= cfg.max_legs) {
    t.state = 'failed';
    log(t, `stopped: ${cfg.max_legs} legs reached (relay.max_legs)`);
    return saveTicket(t);
  }

  const ready = primaryReady(t, now);
  const wantFallback = !t.fallback_done && t.allow_fallback !== false && (t.origin === 'handoff' || cfg.auto_fallback)
    && (t.fallback_first || !ready);
  if (wantFallback) {
    const fails = (a) => t.legs.filter((l) => l.agent === a && l.kind === 'fallback' && l.status !== 'done').length;
    const next = t.chain.find((a) => resolveAgent(a) && !limitedUntil(a) && now >= (t.limits[a] || 0) && fails(a) < 2);
    if (next) {
      startLeg(t, next, 'fallback');
      return saveTicket(t);
    }
  }

  if (ready) {
    const fallbackOwns = cfg.on_reset === 'none' && t.origin === 'hook' && t.fallback_done;
    if (t.resume === 'never' || fallbackOwns || (t.resume === 'on_next_message' && t.fallback_done)) {
      if (t.resume === 'never' || fallbackOwns || now - t.created_at > 24 * 3600e3) {
        t.state = 'done';
        log(t, 'done (primary not resumed by request)');
      }
      return saveTicket(t);
    }
    if (t.resume !== 'on_next_message' || !t.fallback_first) {
      startLeg(t, t.primary.agent, t.primary.session_id ? 'resume' : 'start');
      return saveTicket(t);
    }
  }

  const waits = [t.limits[t.primary.agent], ...t.chain.map((a) => t.limits[a] || limitedUntil(a))].filter((x) => x > now);
  t.next_check = waits.length ? Math.min(...waits) : null;
  return saveTicket(t);
}

// ---- Waker daemon -----------------------------------------------------------

export function wakerRunning() {
  const w = readJSON(WAKER_PID);
  return w && pidAlive(w.pid) ? w : null;
}

export function ensureWaker() {
  if (wakerRunning()) return false;
  spawnDetached(['waker'], { logFile: WAKER_LOG });
  return true;
}

export async function wakerLoop({ once = false } = {}) {
  ensureDir(APP_HOME);
  const other = wakerRunning();
  if (other && other.pid !== process.pid && !once) return;
  if (!once) writeJSON(WAKER_PID, { pid: process.pid, started: Date.now() });
  appendLog(WAKER_LOG, `waker ${once ? 'single pass' : `started (pid ${process.pid})`}`);
  let idle = 0;
  for (;;) {
    const active = listTickets({ active: true });
    for (const t of active) {
      try { stepTicket(t); } catch (e) { appendLog(WAKER_LOG, `[${t.id}] step error: ${e.stack || e}`); }
    }
    if (once) return;
    if (readJSON(WAKER_PID)?.pid !== process.pid) return; // replaced by another waker
    idle = active.length ? 0 : idle + 1;
    if (idle >= 8) break;
    await sleep(15000);
  }
  try { if (readJSON(WAKER_PID)?.pid === process.pid) fs.unlinkSync(WAKER_PID); } catch {}
  appendLog(WAKER_LOG, 'waker idle, exiting');
}

// ---- Claude Code hooks ------------------------------------------------------

const IGNORED_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
  'invalid_request', 'model_not_found', 'max_output_tokens', 'cloud_credential_error']);

/** StopFailure: a Claude turn died on an API error. Relay on usage limits. */
export function onStopFailure(input) {
  const cfg = loadConfig();
  if (!cfg.enabled || depth() > 0) return null;
  if (IGNORED_ERRORS.has(input.error)) return null;
  const text = [input.error_details, input.last_assistant_message].filter(Boolean).join('\n');
  const now = Date.now();
  let until = parseResetTime(text);
  let kind = until ? 'limit' : classifyFailure(text);
  if (!kind && ['rate_limit', 'overloaded', 'server_error'].includes(input.error)) kind = 'transient';
  if (!kind && input.error === 'billing_error') kind = 'limit';
  if (!kind) return null;
  if (!until) until = now + (kind === 'limit' ? cfg.unknown_reset_retry_min : cfg.transient_retry_min) * 60e3;
  if (kind === 'limit') markLimited('claude', until, text);

  const cwd = input.cwd || process.cwd();
  const existing = listTickets({ active: true }).find((t) => t.primary.agent === 'claude' && t.primary.session_id === input.session_id);
  if (existing) {
    existing.limits.claude = until;
    if (kind === 'limit') existing.allow_fallback = true;
    log(existing, `Claude limited again until ${fmtTime(until)}`);
    saveTicket(existing);
    ensureWaker();
    return { systemMessage: `Relay: Claude is paused until ${fmtTime(until)}; relay ${existing.id} keeps going.` };
  }

  const reason = kind === 'limit' ? `usage limit (resets ${fmtTime(until)})` : `API ${input.error || 'error'} (retrying ${fmtIn(until)})`;
  let batonPath;
  try {
    // Carry earlier agents' reports into the fresh baton so nothing is lost.
    let carried = '';
    try {
      const old = fs.readFileSync(path.join(cwd, '.relay', 'baton.md'), 'utf8');
      const sections = old.split(/\n(?=## )/).filter((s) => /^## (Report from|Relay log)/.test(s));
      if (sections.length) carried = `\n\n## Earlier reports from other agents\n${sections.join('\n').replace(/^## /gm, '### ')}`;
    } catch {}
    const md = batonFromClaudeTranscript(input.transcript_path, { cwd, sessionId: input.session_id, reason }) + carried;
    batonPath = writeBaton(cwd, md, { from: 'claude', reason });
  } catch (e) {
    batonPath = writeBaton(APP_HOME, `# Relay baton\nCould not read transcript: ${e.message}`, { from: 'claude' });
  }
  const t = createTicket({
    origin: 'hook',
    cwd,
    primary: { agent: 'claude', session_id: input.session_id, transcript_path: input.transcript_path },
    access: accessFromPermissionMode(input.permission_mode),
    baton_path: batonPath,
    limits: { claude: until },
    allow_fallback: kind === 'limit',
    reason,
  });
  stepTicket(t);
  ensureWaker();
  const fb = getTicket(t.id).legs.find((l) => l.kind === 'fallback');
  const msg = fb
    ? `Relay: Claude hit its limit. ${label(fb.agent)} is continuing this task now; Claude resumes ${fmtIn(until + cfg.resume_buffer_sec * 1000)} to review it. (relay ${t.id})`
    : `Relay: Claude will resume this task automatically ${fmtIn(until + cfg.resume_buffer_sec * 1000)}. (relay ${t.id})`;
  if (!fb) notify('Relay', msg.replace('Relay: ', ''));
  return { systemMessage: msg };
}

/** SessionStart: make sure pending relays have a waker. */
export function onSessionStart() {
  if (depth() > 0) return null;
  if (listTickets({ active: true }).length) ensureWaker();
  return null;
}

/** UserPromptSubmit: the human is back in a session that has a relay going. */
export function onUserPrompt(input) {
  if (depth() > 0 || !input.session_id) return null;
  const t = listTickets({ active: true }).find((x) => x.primary.agent === 'claude' && x.primary.session_id === input.session_id);
  if (!t) return null;
  const running = t.legs.find((l) => l.status === 'running');
  let ctx;
  if (running && running.kind === 'fallback') {
    // The human is here, so don't resume headlessly later; report on their next message instead.
    t.resume = 'on_next_message';
    t.fallback_first = true;
    ctx = `[Relay] While you were rate-limited, ${label(running.agent)} has been working on this task in the background (job ${running.job_id}, started ${fmtTime(running.started_at)}). `
      + `Its notes go in ${t.baton_path}. Avoid editing the same files until it finishes; check or cancel it with the relay "relays" tool (id ${t.id}).`;
  } else {
    const prior = reportsSoFar(t);
    ctx = prior
      ? `[Relay] While you were rate-limited, other agents continued this task. Review their work (git diff) before continuing. Reports:\n\n${prior}`
      : null;
    t.state = 'done';
    log(t, 'user returned to the session; relay closed');
  }
  t.reported = true;
  saveTicket(t);
  return ctx ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } } : null;
}

export function cancelTicket(id) {
  const t = getTicket(id);
  if (!t) return null;
  for (const l of t.legs) if (l.status === 'running') { cancelJob(l.job_id); l.status = 'cancelled'; }
  t.state = 'cancelled';
  log(t, 'cancelled');
  return saveTicket(t);
}

export function resumeNow(id) {
  const t = getTicket(id);
  if (!t) return null;
  t.limits[t.primary.agent] = 0;
  t.state = 'active';
  log(t, 'resume requested now');
  saveTicket(t);
  ensureWaker();
  return stepTicket(t);
}

export function describeTicket(t) {
  const legs = t.legs.map((l) => `${label(l.agent)}:${l.kind}:${l.status}`).join(' → ') || 'no legs yet';
  const until = t.limits[t.primary.agent];
  return `${t.id} [${t.state}] ${label(t.primary.agent)} @ ${t.cwd} · ${legs}${t.state === 'active' && until > Date.now() ? ` · ${label(t.primary.agent)} back ${fmtIn(until)}` : ''}`;
}

export { event };
