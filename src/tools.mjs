// Relay's MCP tools.
import { fmtTime, fmtIn } from './core/util.mjs';
import { LABEL } from './core/agents.mjs';
import { getTicket, cancelTicket, resumeNow, describeTicket } from './relay.mjs';
import { handoff, status, detectCaller } from './ops.mjs';

const AGENT_ENUM = ['claude', 'codex', 'gemini'];

export const TOOLS = [
  {
    name: 'status',
    description: 'Which AI agents (claude, codex, gemini) are installed, which are usage-limited and until when (plus Codex usage %), and active relays. Call before handing off.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'handoff',
    description: 'Hand the current task to another AI agent (relay). Writes your baton (handoff notes) to <cwd>/.relay/baton.md, starts the partner in the background, and arranges for you to be woken up later to review its work: after your usage limit resets (if you are limited), or on the user\'s next message. Use when you are near or at your usage limit, or when another agent is better suited.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: [...AGENT_ENUM, 'auto'], description: 'Partner agent. "auto" = first available in the fallback chain.' },
        baton: { type: 'string', description: 'Markdown handoff notes: goal, what is done, what is left (ordered), key files, decisions and gotchas, how to verify.' },
        task: { type: 'string', description: 'One-paragraph statement of the overall task.' },
        cwd: { type: 'string', description: 'Absolute project directory. Always pass it.' },
        access: { type: 'string', enum: ['read', 'write', 'full'], description: 'What the partner may do. write (default) = edit files in cwd; full = no sandbox, only if the user\'s session already bypasses permissions.' },
        resume: { type: 'string', enum: ['after_reset', 'after_handoff', 'on_next_message', 'never'], description: 'When to bring you back. Default: after_reset if you are limited, else on_next_message.' },
        reset_at: { type: 'string', description: 'When your own limit resets, if known (ISO time, or text like "3pm" / "in 2 hours").' },
        from_session_id: { type: 'string', description: 'Your own session id if known (Claude Code: ${CLAUDE_SESSION_ID}).' },
      },
      required: ['to', 'baton'],
    },
  },
  {
    name: 'relays',
    description: 'List relays, or show / cancel / wake one. With no id: list recent relays.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'relay-… id.' },
        action: { type: 'string', enum: ['show', 'cancel', 'resume_now'], description: 'resume_now wakes the primary agent immediately.' },
      },
    },
  },
];

export const instructions = () => `Relay lets you (${detectCaller() || 'this agent'}) hand your task to another AI coding agent (Claude Code, Codex or Gemini) `
  + 'when you are at or near your usage limit, and wakes you up later to review its work and finish. In Claude Code this also happens automatically '
  + 'when a usage limit stops the session. Use "status" to see who is available, then "handoff" with a thorough baton. Always pass cwd.';

export async function call(name, a) {
  if (name === 'status') {
    const s = status();
    const ag = s.agents.map((x) => `- ${LABEL[x.agent]}: ${!x.installed ? 'not installed' : x.limited_until ? `usage-limited until ${fmtTime(x.limited_until)} (${fmtIn(x.limited_until)})` : 'available'}${x.usage ? ` · Codex usage ${x.usage}` : ''}`).join('\n');
    return `You are: ${s.caller || 'unknown'}\nAgents:\n${ag}\nWaker: ${s.waker}\nRelays:\n${s.relays.map((x) => `- ${x}`).join('\n') || '- none'}`;
  }
  if (name === 'handoff') {
    const r = handoff(a);
    return r.ok ? `${r.message}\nRelay id: ${r.ticket_id}` : `Handoff ${r.ticket_id ? `queued as ${r.ticket_id}` : 'failed'}: ${r.message || r.error}`;
  }
  if (name === 'relays') {
    if (!a.id) return `Relays:\n${status().relays.map((x) => `- ${x}`).join('\n') || '- none'}`;
    const t = a.action === 'cancel' ? cancelTicket(a.id) : a.action === 'resume_now' ? resumeNow(a.id) : getTicket(a.id);
    return t ? `${describeTicket(t)}\nBaton: ${t.baton_path}\n\n${(t.log || []).slice(-15).join('\n')}` : 'No such relay.';
  }
  throw new Error(`Unknown tool: ${name}`);
}
