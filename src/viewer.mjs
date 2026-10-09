// Relay live viewer: a small local web page that streams what each relay leg is doing,
// for every agent (Claude, Codex, Antigravity). Read-only; binds to 127.0.0.1 by default.
//
//   GET /api/relays           recent relays with their legs
//   GET /api/feed?job=<id>    Server-Sent Events: the leg's activity as feed items
//   GET /api/baton?id=<id>    the relay's baton (handoff notes + reports)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_HOME, VERSION, writeJSON, readJSON, appendLog } from './core/util.mjs';
import { loadConfig } from './core/config.mjs';
import { getJob, jobEvents, isTerminal } from './core/jobs.mjs';
import { listTickets, getTicket } from './relay.mjs';
import { VIEWER_PID, appLink, APP_NAME } from './live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(APP_HOME, 'viewer.log');
const STATIC = {
  '/': ['viewer/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['viewer/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['viewer/style.css', 'text/css; charset=utf-8'],
  '/logo.png': ['viewer/logo.png', 'image/png'],
};

// ---- Normalizers: raw agent events → feed items ---------------------------------
// An item is a patch keyed by `key`; the page merges patches with the same key.
// kinds: note, msg, think, cmd, tool, edit, todo, error, end

const cut = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const tail = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `…${s.slice(-n)}` : s;
};

/** Codex wraps shell commands (powershell -Command '…', bash -lc '…'); show just the command. */
export function unwrapShell(cmd) {
  const s = String(cmd || '').trim();
  const ps = s.match(/^(?:"[^"]*?(?:powershell|pwsh)(?:\.exe)?"|\S*?(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+)*?-Command\s+(['"])([\s\S]*)\1$/i);
  // Codex prints argv shell-quoted: inside "…", backslashes are doubled and ' becomes '"'.
  if (ps) return ps[1] === "'" ? ps[2].replace(/''/g, "'") : ps[2].replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/'"'/g, "'");
  const sh = s.match(/^(?:"[^"]*?|\S*?)(?:ba|z)?sh(?:\.exe)?"?\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return sh ? sh[2] : s;
}

function rel(p, cwd) {
  if (!p || !cwd) return p;
  const a = String(p).replace(/\\/g, '/');
  const b = `${String(cwd).replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return a.toLowerCase().startsWith(b.toLowerCase()) ? a.slice(b.length) : p;
}

function inputSummary(input, cwd) {
  if (!input || typeof input !== 'object') return cut(input, 200);
  const v = input.file_path || input.path || input.notebook_path || input.command || input.pattern || input.url || input.query
    || input.description || input.prompt || input.skill;
  if (v) return cut(rel(v, cwd), 200);
  return cut(JSON.stringify(input), 200);
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '')).join('\n') : '');

function claudeNormalizer(cwd) {
  let n = 0;
  return (j) => {
    const out = [];
    if (j.type === 'system' && j.subtype === 'init') {
      out.push({ key: 'init', kind: 'note', text: `Claude started${j.model ? ` · ${j.model}` : ''}`, session: j.session_id });
    } else if (j.type === 'assistant') {
      for (const c of j.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) out.push({ key: `m${n++}`, kind: 'msg', text: cut(c.text, 30000) });
        else if (c.type === 'thinking' && c.thinking?.trim()) out.push({ key: `t${n++}`, kind: 'think', text: cut(c.thinking, 8000) });
        else if (c.type === 'tool_use') {
          const inp = c.input || {};
          if (['Bash', 'PowerShell'].includes(c.name)) out.push({ key: c.id, kind: 'cmd', command: cut(inp.command, 4000), note: inp.description, status: 'running' });
          else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) {
            out.push({ key: c.id, kind: 'edit', files: [{ path: rel(inp.file_path || inp.notebook_path, cwd), op: c.name === 'Write' ? 'write' : 'edit' }], status: 'running' });
          } else if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) {
            out.push({ key: c.id, kind: 'todo', items: inp.todos.map((x) => ({ text: x.content, done: x.status === 'completed', active: x.status === 'in_progress' })) });
          } else out.push({ key: c.id, kind: 'tool', name: c.name, detail: inputSummary(inp, cwd), status: 'running' });
        }
      }
    } else if (j.type === 'user') {
      for (const c of Array.isArray(j.message?.content) ? j.message.content : []) {
        if (c.type === 'tool_result') out.push({ key: c.tool_use_id, output: tail(textOf(c.content), 6000), status: c.is_error ? 'fail' : 'ok' });
      }
    } else if (j.type === 'rate_limit_event' && j.rate_limit_info?.status === 'rejected') {
      const at = j.rate_limit_info.resetsAt;
      out.push({ key: `e${n++}`, kind: 'error', text: `Usage limit reached${at ? ` · resets ${new Date(at < 1e12 ? at * 1000 : at).toLocaleString()}` : ''}` });
    } else if (j.type === 'result') {
      out.push({
        key: 'end', kind: 'end', ok: !j.is_error && (!j.subtype || j.subtype === 'success'), text: cut(j.result, 30000),
        stats: { turns: j.num_turns, cost_usd: j.total_cost_usd, duration_ms: j.duration_ms },
      });
    }
    return out;
  };
}

function codexNormalizer(cwd) {
  let gen = 0;
  let n = 0;
  return (j) => {
    const out = [];
    if (j.type === 'thread.started') {
      gen++;
      out.push({ key: `init${gen}`, kind: 'note', text: gen > 1 ? 'Codex restarted (switched sandbox mode)' : 'Codex started', session: j.thread_id });
    } else if (/^item\.(started|updated|completed)$/.test(j.type) && j.item) {
      const it = j.item;
      const key = `${gen}:${it.id}`;
      const done = j.type === 'item.completed';
      const st = !done ? 'running' : it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0) ? 'fail' : 'ok';
      switch (it.type) {
        case 'agent_message': if (it.text?.trim()) out.push({ key, kind: 'msg', text: cut(it.text, 30000) }); break;
        case 'reasoning': if (it.text?.trim()) out.push({ key, kind: 'think', text: cut(it.text, 8000) }); break;
        case 'command_execution':
          out.push({ key, kind: 'cmd', command: cut(unwrapShell(it.command), 4000), output: tail(it.aggregated_output, 6000), exit: it.exit_code, status: st });
          break;
        case 'file_change':
          out.push({ key, kind: 'edit', files: (it.changes || []).map((c) => ({ path: rel(c.path, cwd), op: c.kind })), status: st });
          break;
        case 'mcp_tool_call':
          out.push({ key, kind: 'tool', name: [it.server, it.tool].filter(Boolean).join('.'), detail: inputSummary(it.arguments, cwd), output: it.error?.message || '', status: st });
          break;
        case 'web_search': out.push({ key, kind: 'tool', name: 'Web search', detail: cut(it.query, 200), status: st }); break;
        case 'todo_list': out.push({ key, kind: 'todo', items: (it.items || []).map((x) => ({ text: x.text, done: !!x.completed })) }); break;
        case 'error': out.push({ key, kind: 'error', text: cut(it.message, 4000) }); break;
        default: if (done && it.type) out.push({ key, kind: 'tool', name: it.type.replace(/_/g, ' '), detail: '', status: st });
      }
    } else if (j.type === 'turn.completed') {
      const u = j.usage || {};
      out.push({ key: `end${gen}`, kind: 'end', ok: true, stats: { tokens: (u.input_tokens || 0) + (u.output_tokens || 0) } });
    } else if (j.type === 'turn.failed') {
      out.push({ key: `end${gen}`, kind: 'end', ok: false, text: cut(j.error?.message || JSON.stringify(j.error), 4000) });
    } else if (j.type === 'error') {
      out.push({ key: `e${n++}`, kind: 'error', text: cut(j.message || JSON.stringify(j), 4000) });
    }
    return out;
  };
}

function antigravityNormalizer(cwd) {
  let n = 0;
  let msgKey = null;
  let msgText = '';
  let openTool = null;
  let started = false;
  return (j) => {
    const out = [];
    if (j.__plain) {
      out.push({ key: `p${n++}`, kind: 'note', text: cut(j.__plain, 2000) });
      return out;
    }
    const ev = j.event;
    const p = (ev && j[ev]) || j.payload || j;
    if (!started && p?.conversation_id) {
      started = true;
      out.push({ key: 'init', kind: 'note', text: 'Antigravity started', session: p.conversation_id });
    }
    if (ev === 'step_update') {
      const id = p.step_index ?? p.step_id ?? p.id;
      if (p.step_type === 'agent_response' && p.text_delta) {
        if (!msgKey || (id != null && msgKey !== `m${id}`)) { msgKey = id != null ? `m${id}` : `m${n++}`; msgText = ''; }
        msgText += p.text_delta;
        out.push({ key: msgKey, kind: 'msg', text: cut(msgText, 30000) });
      } else if (p.step_type === 'tool') {
        msgKey = null;
        const state = String(p.state || '').toUpperCase();
        const status = /ERROR|FAIL|CANCEL/.test(state) ? 'fail' : /DONE|COMPLETE|SUCCESS|FINISH/.test(state) ? 'ok' : 'running';
        let key = id != null ? `s${id}` : null;
        if (!key) key = status === 'running' || !openTool ? `s${n++}` : openTool;
        openTool = status === 'running' ? key : null;
        const name = p.tool_name || 'tool';
        const args = p.args || p.input || p.tool_input || p.arguments;
        const isCmd = /command|shell|terminal/i.test(name) && args && (args.command || args.CommandLine);
        out.push(isCmd
          ? { key, kind: 'cmd', command: cut(args.command || args.CommandLine, 4000), output: tail(p.output || p.result, 6000), status }
          : { key, kind: 'tool', name, detail: inputSummary(args, cwd), output: tail(typeof p.output === 'string' ? p.output : '', 6000), status });
      }
    } else if (ev === 'result' || (!ev && p?.status && 'response' in p)) {
      out.push({ key: 'end', kind: 'end', ok: !p.status || p.status === 'SUCCESS', text: cut(p.response || p.error, 30000), stats: { turns: p.num_turns } });
    }
    return out;
  };
}

const NORMALIZERS = { claude: claudeNormalizer, codex: codexNormalizer, antigravity: antigravityNormalizer };

export function normalizer(agent, cwd) {
  const f = (NORMALIZERS[agent] || claudeNormalizer)(cwd);
  return (line) => {
    let j;
    try { j = JSON.parse(line); } catch { j = { __plain: line }; }
    if (j.__plain && agent !== 'antigravity') return [];
    try { return f(j); } catch { return []; }
  };
}

// ---- API --------------------------------------------------------------------------

function relaysJson() {
  return listTickets().slice(0, 40).map((t) => ({
    id: t.id,
    title: t.title || path.basename(t.cwd),
    project: path.basename(t.cwd),
    cwd: t.cwd,
    state: t.state,
    reason: t.reason || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    primary: t.primary.agent,
    back_at: t.limits?.[t.primary.agent] || null,
    log: (t.log || []).slice(-12),
    legs: t.legs.map((l) => {
      const j = l.status === 'running' ? getJob(l.job_id) : null;
      const session = l.session_id || j?.session_id || null;
      const link = appLink({ ...l, session_id: session });
      return {
        agent: l.agent, kind: l.kind, status: l.status, job_id: l.job_id, started_at: l.started_at, ended_at: l.ended_at || null,
        session_id: session, app_link: link, app_name: link ? APP_NAME[l.agent] : null, summary: l.summary ? cut(l.summary, 4000) : null,
      };
    }),
  }));
}

function sendJson(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

let clients = 0;
let lastHit = Date.now();

function feed(req, res, jobId) {
  const job = getJob(jobId);
  if (!job) { res.writeHead(404); return res.end('no such job'); }
  const cwd = job.params?.cwd;
  const norm = normalizer(job.params?.agent, cwd);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  clients++;
  const file = jobEvents(jobId);
  let pos = 0;
  let rest = '';
  let closed = false;
  let beat = 0;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const pump = () => {
    if (closed) return;
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > pos) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size - pos, 4 * 1024 * 1024));
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos += got;
      const lines = (rest + buf.subarray(0, got).toString('utf8')).split('\n');
      rest = lines.pop();
      const items = lines.filter((l) => l.trim()).flatMap((l) => norm(l.replace(/\r$/, '')));
      if (items.length) send('items', items);
      if (pos < size) return setImmediate(pump);
    }
    const j = getJob(jobId);
    if (!j || isTerminal(j)) {
      if (rest.trim()) { const items = norm(rest); rest = ''; if (items.length) send('items', items); }
      send('end', { status: j?.status || 'lost', error: j?.error ? cut(j.error, 2000) : null });
      return res.end();
    }
    if (++beat % 25 === 0) res.write(': keepalive\n\n');
    setTimeout(pump, 600);
  };
  req.on('close', () => { closed = true; clients--; });
  pump();
}

function allowedHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const cfg = loadConfig();
  return ['127.0.0.1', 'localhost', '::1', String(cfg.viewer_host || '').toLowerCase()].includes(host);
}

function handle(req, res) {
  lastHit = Date.now();
  // Only answer requests addressed to this machine by name (blocks DNS-rebinding pages).
  if (!allowedHost(req)) { res.writeHead(403); return res.end('forbidden host'); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const sec = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
  for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
  const st = STATIC[url.pathname];
  if (st) {
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
    try {
      const body = fs.readFileSync(path.join(HERE, st[0]));
      res.writeHead(200, { 'content-type': st[1], 'cache-control': 'no-cache' });
      return res.end(body);
    } catch { res.writeHead(404); return res.end(); }
  }
  if (url.pathname === '/api/ping') return sendJson(res, { app: 'relay-viewer', version: VERSION, pid: process.pid });
  if (url.pathname === '/api/relays') return sendJson(res, { version: VERSION, now: Date.now(), relays: relaysJson() });
  if (url.pathname === '/api/feed') {
    const id = url.searchParams.get('job') || '';
    if (!/^job-[\w-]{4,80}$/.test(id)) { res.writeHead(400); return res.end('bad job id'); }
    return feed(req, res, id);
  }
  if (url.pathname === '/api/baton') {
    const t = getTicket(String(url.searchParams.get('id') || '').replace(/[^\w-]/g, ''));
    let md = '';
    try { md = fs.readFileSync(t?.baton_path, 'utf8'); } catch {}
    return sendJson(res, { path: t?.baton_path || null, markdown: tail(md, 200000) });
  }
  res.writeHead(404);
  res.end('not found');
}

/** Body of the detached `relay _viewer` process. */
export async function serveViewer() {
  const cfg = loadConfig();
  const host = cfg.viewer_host || '127.0.0.1';
  const server = http.createServer(handle);
  server.on('error', (e) => {
    appendLog(LOG, e.code === 'EADDRINUSE' ? `port ${cfg.viewer_port} is busy (another viewer?)` : `server error: ${e.message}`);
    process.exit(0);
  });
  server.listen(cfg.viewer_port, host, () => {
    writeJSON(VIEWER_PID, { pid: process.pid, port: cfg.viewer_port, host, started: Date.now() });
    appendLog(LOG, `viewer on http://${host}:${cfg.viewer_port} (pid ${process.pid})`);
  });
  // Stay up while relays are active or someone is watching; otherwise exit after 20 idle minutes.
  setInterval(() => {
    const busy = clients > 0 || listTickets({ active: true }).length > 0;
    if (busy) lastHit = Date.now();
    if (Date.now() - lastHit > 20 * 60e3) {
      try { if (readJSON(VIEWER_PID)?.pid === process.pid) fs.unlinkSync(VIEWER_PID); } catch {}
      appendLog(LOG, 'viewer idle, exiting');
      process.exit(0);
    }
  }, 60e3).unref?.();
  return new Promise(() => {});
}

export const _test = { unwrapShell, normalizer };
