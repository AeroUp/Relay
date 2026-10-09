// Offline checks: no agent calls, no usage spent. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResetTime, classifyFailure } from '../src/core/limits.mjs';
import { batonFromClaudeTranscript, accessFromPermissionMode } from '../src/relay.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'relay.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-selftest-'));
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(`✔ ${name}`); } catch (e) { results.push(`✖ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

function mcpClient() {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_AGENT_SELF: 'selftest', RELAY_HOME: TMP, AGENT_STATE_DIR: TMP },
  });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id !== undefined) replies.set(m.id, m);
    }
  });
  let next = 1;
  return {
    async request(method, params) {
      const id = next++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let k = 0; k < 300 && !replies.has(id); k++) await new Promise((r) => setTimeout(r, 50));
      return replies.get(id);
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

export async function selftest() {
  const now = Date.UTC(2026, 9, 8, 18, 0); // 2pm in New York

  await t('Claude: "resets 3pm (America/New_York)"', () => {
    assert.equal(parseResetTime("You've hit your session limit · resets 3pm (America/New_York)", now), Date.UTC(2026, 9, 8, 19, 0));
  });
  await t('Claude: a time already passed today rolls to tomorrow', () => {
    assert.equal(parseResetTime('resets 1pm (America/New_York)', now), Date.UTC(2026, 9, 9, 17, 0));
  });
  await t('Claude: "resets Oct 10, 9:30am (Europe/London)"', () => {
    assert.equal(parseResetTime("You've hit your weekly limit · resets Oct 10, 9:30am (Europe/London)", now), Date.UTC(2026, 9, 10, 8, 30));
  });
  await t('Codex: "try again in 2 hours 13 minutes"', () => {
    assert.equal(parseResetTime("You've hit your usage limit. Try again in 2 hours 13 minutes.", now), now + (2 * 60 + 13) * 60e3);
  });
  await t('Antigravity/Gemini: "Please retry in 34.5s"', () => {
    assert.equal(parseResetTime('Quota exceeded. Please retry in 34.5s.', now), now + 34500);
  });
  await t('classify: limit vs transient vs unrelated', () => {
    assert.equal(classifyFailure("You've hit your usage limit"), 'limit');
    assert.equal(classifyFailure('API Error: 529 overloaded'), 'transient');
    assert.equal(classifyFailure('TypeError: x is undefined'), null);
  });
  await t('permission mode → access level', () => {
    assert.equal(accessFromPermissionMode('bypassPermissions'), 'full');
    assert.equal(accessFromPermissionMode('acceptEdits'), 'write');
    assert.equal(accessFromPermissionMode('plan'), 'read');
  });
  await t('baton from a Claude Code transcript', () => {
    const file = path.join(TMP, 'transcript.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: 'Build a CLI that converts CSV to JSON' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Starting with the parser.' }, { type: 'tool_use', name: 'Write', input: { file_path: '/p/src/parse.js' } }] } },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'also support TSV', origin: { kind: 'human' } } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'parser', status: 'completed' }, { content: 'TSV', status: 'pending' }] } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', isSidechain: true, message: { content: 'subagent noise' } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    const md = batonFromClaudeTranscript(file, { cwd: '/p', sessionId: 'abc', reason: 'usage limit' });
    assert.match(md, /## Original request\nBuild a CLI that converts CSV to JSON/);
    assert.match(md, /also support TSV/);
    assert.match(md, /- \[x\] parser/);
    assert.match(md, /- \[ \] TSV/);
    assert.match(md, /\/p\/src\/parse\.js/);
    assert.doesNotMatch(md, /subagent noise/);
  });
  await t('live viewer: shell commands shown the way the agent wrote them', async () => {
    const { _test: v } = await import('../src/viewer.mjs');
    assert.equal(v.unwrapShell(`"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -Command "Get-Content .relay\\\\baton.md; rg -g '"'!.git'"'"`),
      "Get-Content .relay\\baton.md; rg -g '!.git'");
    assert.equal(v.unwrapShell(`"C:\\\\x\\\\powershell.exe" -Command 'node a.js; echo ''hi'''`), "node a.js; echo 'hi'");
    assert.equal(v.unwrapShell(`/bin/bash -lc 'npm test'`), 'npm test');
    assert.equal(v.unwrapShell('git status'), 'git status');
  });
  await t('live viewer: Codex and Claude events become feed items', async () => {
    const { _test: v } = await import('../src/viewer.mjs');
    const cx = v.normalizer('codex', 'C:\\p');
    const feed = [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'On it.' } },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "ls"', aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "ls"', aggregated_output: 'a.js', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'C:\\p\\src\\a.js', kind: 'update' }], status: 'completed' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 50 } },
    ].flatMap((e) => cx(JSON.stringify(e)));
    assert.deepEqual(feed.map((i) => i.kind), ['note', 'msg', 'cmd', 'cmd', 'edit', 'end']);
    assert.equal(feed[0].session, 'th-1');
    assert.equal(feed[3].status, 'ok');
    assert.equal(feed[3].command, 'ls');
    assert.equal(feed[4].files[0].path, 'src/a.js');
    const cl = v.normalizer('claude', '/p');
    const items = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] } },
      { type: 'result', subtype: 'success', result: 'Done.', num_turns: 3 },
    ].flatMap((e) => cl(JSON.stringify(e)));
    assert.deepEqual(items.map((i) => i.kind ?? 'patch'), ['msg', 'cmd', 'patch', 'end']);
    assert.equal(items[2].key, 'tu1');
    assert.equal(items[2].status, 'ok');
  });
  await t('notifications: toast buttons are escaped XML', async () => {
    const { toastXml } = await import('../src/core/util.mjs');
    const x = toastXml('Relay', 'a <b> & "c"', { url: 'http://127.0.0.1:7575/#r', actions: [{ label: 'Open in ChatGPT', url: 'codex://threads/abc' }] });
    assert.match(x, /launch="http:\/\/127\.0\.0\.1:7575\/#r"/);
    assert.match(x, /<action content="Open in ChatGPT" activationType="protocol" arguments="codex:\/\/threads\/abc"\/>/);
    assert.match(x, /a &lt;b&gt; &amp; &quot;c&quot;/);
  });
  await t('relay titles come from the original request', async () => {
    const { batonTitle } = await import('../src/relay.mjs');
    assert.equal(batonTitle('# Relay baton — x\n\n## Original request\nmake the   overlay pop up\n'), 'make the overlay pop up');
    assert.equal(batonTitle('# Ship the login page\n\nnotes'), 'Ship the login page');
  });
  await t('MCP: handshake, tools/list, status tool', async () => {
    const c = mcpClient();
    try {
      const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } });
      assert.equal(init.result.serverInfo.name, 'relay');
      const names = (await c.request('tools/list')).result.tools.map((x) => x.name);
      for (const n of ['status', 'handoff', 'relays']) assert.ok(names.includes(n), `missing tool ${n}`);
      const st = await c.request('tools/call', { name: 'status', arguments: {} });
      assert.ok(st?.result?.content?.[0]?.text?.includes('Agents:'), 'status tool output');
    } finally {
      c.close();
    }
  });

  console.log(results.join('\n'));
}
