// Relay live viewer: lists relays and streams the selected turn's activity.
'use strict';

const $ = (s) => document.querySelector(s);
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}

const AGENT = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const LEG_KIND = { fallback: 'took over', resume: 'came back', start: 'started' };
const LEG_STATUS = { running: 'working', done: 'finished', failed: 'failed', limited: 'hit its limit', preempted: 'stopped', cancelled: 'cancelled', lost: 'stopped unexpectedly' };
const STATE = { active: 'live', done: 'done', failed: 'failed', cancelled: 'cancelled' };

let relays = [];
let skew = 0; // server clock - browser clock (phones over Tailscale can drift)
const sel = { id: null, leg: null, pinned: false };
let feed = null; // { job, es, items: Map(key → { data, node }), ended }

const now = () => Date.now() + skew;

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function ago(t) {
  const m = Math.round((now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---- Markdown, safely: builds DOM nodes, never innerHTML ------------------------

function inline(text) {
  const out = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok[0] === '`' ? el('code', null, tok.slice(1, -1)) : el('strong', null, tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function md(text) {
  const root = el('div', 'md');
  const parts = String(text || '').split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { root.append(el('pre', null, part.replace(/\n$/, ''))); return; }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d/.test(lines[0]);
        root.append(el(ordered ? 'ol' : 'ul', null, lines.map((l) => el('li', null, inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, '').replace(/^\[( |x|~)\]\s*/i, (s) => (s.includes('x') ? '✓ ' : s.includes('~') ? '… ' : '☐ ')))))));
      } else if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) {
        root.append(el('h4', null, inline(lines[0].replace(/^#+\s*/, ''))));
      } else {
        const p = el('p');
        lines.forEach((l, k) => {
          if (k) p.append(el('br'));
          p.append(...inline(/^#{1,6}\s/.test(l) ? l.replace(/^#+\s*/, '') : l.replace(/^>\s?/, '')));
        });
        root.append(p);
      }
    }
  });
  return root;
}

// ---- Feed items -----------------------------------------------------------------

function statusTag(d) {
  if (d.status === 'running') return el('span', 'spin');
  if (d.kind === 'cmd' && d.exit != null && d.exit !== 0) return el('span', 'tag fail', `exit ${d.exit}`);
  if (d.status === 'fail') return el('span', 'tag fail', 'failed');
  if (d.status === 'ok') return el('span', 'tag ok', '✓');
  return null;
}

function output(d, label) {
  if (!d.output || !String(d.output).trim()) return null;
  const det = el('details', null, el('summary', null, label || 'Output'), el('pre', 'out', d.output));
  if (d.status === 'fail') det.open = true;
  return det;
}

function render(d, agent) {
  switch (d.kind) {
    case 'note': return el('div', 'it-note', d.text);
    case 'msg': {
      const n = md(d.text);
      n.className = 'it-msg md';
      n.style.setProperty('--agent', `var(--${agent})`);
      return n;
    }
    case 'think': return el('details', 'it-think', el('summary', null, 'Thinking'), el('p', null, d.text));
    case 'cmd': {
      const body = el('div', 'body', el('div', 'cmd-line', d.command || ''), d.note ? el('div', 'cmd-note', d.note) : null);
      return el('div', 'box', el('div', 'row', el('span', 'ic', '›'), body, statusTag(d)), output(d));
    }
    case 'tool':
      return el('div', 'box', el('div', 'row', el('span', 'ic', '→'), el('div', 'body', el('span', 'name', d.name || 'tool'), el('span', 'detail', d.detail || '')), statusTag(d)), output(d, 'Result'));
    case 'edit':
      return el('div', 'box', el('div', 'row', el('span', 'ic', '✎'),
        el('div', 'body', el('span', 'name', (d.files || []).length > 1 ? `Edited ${d.files.length} files` : 'Edited'),
          el('div', 'files', (d.files || []).map((f) => el('span', 'file', f.path || '?')))), statusTag(d)));
    case 'todo':
      return el('div', 'box', el('div', 'row', el('span', 'ic', '☰'), el('div', 'body', el('span', 'name', 'Plan'),
        el('ul', 'todo', (d.items || []).map((x) => el('li', x.done ? 'done' : x.active ? 'active' : '', el('span', 'cb', x.done ? '✓' : x.active ? '›' : '○'), x.text))))));
    case 'error': return el('div', 'it-error', d.text);
    case 'end': {
      const s = d.stats || {};
      const stats = [s.turns && `${s.turns} turns`, s.duration_ms && fmtDur(s.duration_ms), s.cost_usd && `$${Number(s.cost_usd).toFixed(2)}`, s.tokens && `${Math.round(s.tokens / 1000)}k tokens`].filter(Boolean).join(' · ');
      return el('div', `it-end${d.ok ? '' : ' fail'}`, el('div', 'head', el('b', null, d.ok ? `${AGENT[agent] || 'Agent'} finished its turn` : 'Stopped'), stats ? el('span', 'stats', stats) : null), d.text ? md(d.text) : null);
    }
    default: return el('div', 'it-note', d.text || '');
  }
}

// ---- Auto-scroll ----------------------------------------------------------------

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
let follow = true;
window.addEventListener('scroll', () => {
  follow = nearBottom();
  $('#jump').hidden = follow || !feed || feed.ended;
}, { passive: true });
$('#jump').addEventListener('click', () => { follow = true; window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); });
const stick = () => { if (follow) window.scrollTo(0, document.documentElement.scrollHeight); };

// ---- Feed stream ----------------------------------------------------------------

function closeFeed() {
  if (feed?.es) feed.es.close();
  feed = null;
}

function openFeed(relay, leg) {
  closeFeed();
  const box = $('#feed');
  box.replaceChildren();
  follow = true;
  if (!leg) return;
  feed = { job: leg.job_id, agent: leg.agent, items: new Map(), ended: false, es: null };
  const f = feed;
  const es = new EventSource(`/api/feed?job=${encodeURIComponent(leg.job_id)}`);
  f.es = es;
  es.addEventListener('items', (e) => {
    if (feed !== f) return;
    for (const patch of JSON.parse(e.data)) {
      const cur = f.items.get(patch.key);
      const data = cur ? { ...cur.data, ...patch } : patch;
      if (!data.kind) continue; // a result for something we never saw
      const node = render(data, f.agent);
      if (cur) cur.node.replaceWith(node);
      else box.append(node);
      f.items.set(patch.key, { data, node });
    }
    stick();
  });
  es.addEventListener('end', (e) => {
    if (feed !== f) return;
    f.ended = true;
    es.close();
    const info = JSON.parse(e.data);
    // Nothing still spinning once the turn is over.
    for (const [, it] of f.items) {
      if (it.data.status === 'running') {
        it.data.status = info.status === 'done' ? 'ok' : 'fail';
        const node = render(it.data, f.agent);
        it.node.replaceWith(node);
        it.node = node;
      }
    }
    if (!f.items.size) {
      box.append(el('div', 'blank', info.status === 'running' ? 'Waiting for activity…'
        : 'No live log for this turn. Relay records activity for turns started after the live viewer was added.'));
    } else if (info.error && ![...f.items.values()].some((x) => x.data.kind === 'end')) {
      box.append(el('div', 'it-error', info.error));
    }
    updateWorking();
    stick();
  });
  es.onerror = () => { if (feed === f && f.ended) es.close(); };
}

async function openBaton(relay) {
  closeFeed();
  const box = $('#feed');
  box.replaceChildren(el('div', 'it-note', 'Loading the baton…'));
  try {
    const r = await fetch(`/api/baton?id=${encodeURIComponent(relay.id)}`).then((x) => x.json());
    if (sel.leg !== 'baton') return;
    box.replaceChildren(r.markdown
      ? el('div', 'baton', el('div', 'path', r.path || ''), md(r.markdown.replace(/^<!--[^]*?-->\s*/, '')))
      : el('div', 'blank', 'No baton file found.'));
  } catch {
    box.replaceChildren(el('div', 'blank', "Couldn't load the baton."));
  }
}

// ---- Relay list + header --------------------------------------------------------

function chain(r) {
  const c = el('span', 'chain');
  r.legs.forEach((l, i) => {
    if (i) c.append(el('span', 'arrow', '→'));
    c.append(el('span', `dot ${l.agent}`));
  });
  if (r.state === 'active' && !r.legs.some((l) => l.status === 'running')) {
    if (r.legs.length) c.append(el('span', 'arrow', '→'));
    c.append(el('span', 'dot ghost'));
  }
  return c;
}

function stateTag(r) {
  return el('span', `state ${STATE[r.state] || ''}`, r.state === 'active' ? el('i') : null, STATE[r.state] || r.state);
}

function renderList() {
  const nav = $('#relays');
  nav.replaceChildren(...relays.map((r) => {
    const b = el('button', `r-item${r.id === sel.id ? ' sel' : ''}`,
      el('div', 'proj', el('b', null, r.project), el('span', 'ago', ago(r.updated_at || r.created_at))),
      el('div', 't', r.title),
      el('div', 'chain-row', el('div', 'chain', chain(r), stateTag(r))));
    b.addEventListener('click', () => { location.hash = r.id; });
    return b;
  }));
  const live = relays.filter((r) => r.state === 'active').length;
  $('#live-pill').hidden = !live;
  $('#live-count').textContent = live === 1 ? '1 live' : `${live} live`;
}

function pickLeg(r) {
  const running = r.legs.findIndex((l) => l.status === 'running');
  return running >= 0 ? running : r.legs.length ? r.legs.length - 1 : 'baton';
}

function copyText(text, btn) {
  const done = () => { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1400); };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy this:', text));
  const ta = el('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { window.prompt('Copy this:', text); }
  ta.remove();
}

function renderRelay() {
  const r = relays.find((x) => x.id === sel.id);
  $('#empty').hidden = !!r;
  $('#relay').hidden = !r;
  if (!r) { closeFeed(); return; }

  $('#r-project').textContent = r.project;
  $('#r-title').textContent = r.title;
  const meta = [`started ${clock(r.created_at)}`, r.reason, r.cwd];
  if (r.state === 'active' && r.back_at > now()) meta.splice(1, 0, `${AGENT[r.primary]} back at ${clock(r.back_at)}`);
  $('#r-meta').replaceChildren(...meta.filter(Boolean).flatMap((m, i) => (i ? [el('span', 'sep', '·'), m] : [m])));

  if (!sel.pinned || sel.leg == null || (sel.leg !== 'baton' && !r.legs[sel.leg])) sel.leg = pickLeg(r);

  const legs = $('#legs');
  const tabs = [el('button', `leg${sel.leg === 'baton' ? ' sel' : ''}`, '📋 Baton')];
  tabs[0].addEventListener('click', () => { sel.leg = 'baton'; sel.pinned = true; renderRelay(); });
  r.legs.forEach((l, i) => {
    const t = el('button', `leg${sel.leg === i ? ' sel' : ''}`, el('span', `dot ${l.agent}`), AGENT[l.agent], el('span', 'st', l.status === 'running' ? 'working' : LEG_STATUS[l.status] || l.status));
    t.setAttribute('role', 'tab');
    t.addEventListener('click', () => { sel.leg = i; sel.pinned = true; renderRelay(); });
    tabs.push(el('span', 'arrow', '→'), t);
  });
  if (r.state === 'active' && !r.legs.some((l) => l.status === 'running')) {
    tabs.push(el('span', 'arrow', '→'), el('span', 'leg ghost', el('span', 'dot ghost'), r.back_at > now() ? `${AGENT[r.primary]} back ${clock(r.back_at)}` : `${AGENT[r.primary]} next`));
  }
  legs.replaceChildren(...tabs);

  const bar = $('#leg-bar');
  if (sel.leg === 'baton') {
    bar.replaceChildren(el('span', 'who', 'Baton'), el('span', 'what', 'The handoff notes every agent reads, plus their reports.'));
    if (feed || !$('#feed').querySelector('.baton')) openBaton(r);
  } else {
    const l = r.legs[sel.leg];
    const actions = el('div', 'actions');
    if (l.app_link) {
      const a = el('a', 'btn primary', `Open in ${l.app_name}`);
      a.href = l.app_link;
      actions.append(a);
    }
    if (l.agent === 'claude' && l.session_id) {
      const b = el('button', 'btn', 'Copy resume command');
      b.addEventListener('click', () => copyText(`cd "${r.cwd}"; claude --resume ${l.session_id}`, b));
      actions.append(b);
    }
    const when = l.status === 'running' ? el('span', 'what', 'for ', el('span', null, fmtDur(now() - l.started_at))) : el('span', 'what', `${clock(l.started_at)} – ${l.ended_at ? clock(l.ended_at) : '?'}`);
    when.dataset.since = l.status === 'running' ? l.started_at : '';
    bar.replaceChildren(el('span', `dot ${l.agent}`), el('span', 'who', `${AGENT[l.agent]} ${LEG_KIND[l.kind] || l.kind}`),
      el('span', 'what', LEG_STATUS[l.status] || l.status), when, actions);
    if (!feed || feed.job !== l.job_id) openFeed(r, l);
  }
  updateWorking();
}

function updateWorking() {
  const r = relays.find((x) => x.id === sel.id);
  const l = r && sel.leg !== 'baton' ? r.legs[sel.leg] : null;
  const on = !!(l && l.status === 'running' && feed && !feed.ended);
  $('#working').hidden = !on;
  if (on) $('#working-text').textContent = `${AGENT[l.agent]} is working… ${fmtDur(now() - l.started_at)}`;
  $('#jump').hidden = follow || !on;
}

function select(id) {
  if (id === sel.id) return;
  sel.id = id;
  sel.leg = null;
  sel.pinned = false;
  closeFeed();
  $('#feed').replaceChildren();
  renderList();
  renderRelay();
  window.scrollTo(0, 0);
}

// ---- Polling --------------------------------------------------------------------

async function refresh() {
  try {
    const r = await fetch('/api/relays', { cache: 'no-store' }).then((x) => x.json());
    skew = r.now - Date.now();
    relays = r.relays;
    $('#conn').hidden = true;
    const want = location.hash.slice(1);
    if (!sel.id || !relays.some((x) => x.id === sel.id)) {
      const pick = relays.find((x) => x.id === want) || relays.find((x) => x.state === 'active') || relays[0];
      if (pick) { sel.id = pick.id; sel.leg = null; sel.pinned = false; }
    }
    renderList();
    renderRelay();
  } catch {
    $('#conn').hidden = false;
  }
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (relays.some((x) => x.id === id)) select(id);
});

setInterval(() => {
  for (const n of document.querySelectorAll('[data-since]')) {
    if (n.dataset.since) n.lastChild.textContent = fmtDur(now() - Number(n.dataset.since));
  }
  updateWorking();
}, 1000);

refresh();
setInterval(refresh, 2500);
