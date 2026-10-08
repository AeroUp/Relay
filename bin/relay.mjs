#!/usr/bin/env node
// Relay: when your AI agent runs out of usage, another one takes the baton,
// and the first one wakes up to finish when its limit resets.
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, APP_HOME, fmtTime, fmtIn } from '../src/core/util.mjs';
import { loadConfig, setConfigValue, CONFIG_PATH } from '../src/core/config.mjs';
import { LABEL, agentVersion } from '../src/core/agents.mjs';
import { runJobProcess, readJobLog } from '../src/core/jobs.mjs';
import { OPS, status, autopilot, handoff } from '../src/ops.mjs';
import {
  wakerLoop, onStopFailure, onSessionStart, onUserPrompt, listTickets, describeTicket, cancelTicket, resumeNow, getTicket,
} from '../src/relay.mjs';

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const BOOL = new Set(['wait', 'once', 'no-autostart']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

function showTicket(t) {
  if (!t) return console.log('No such relay.');
  console.log(`${describeTicket(t)}\nBaton: ${t.baton_path}\n\n${(t.log || []).join('\n')}`);
  const running = t.legs.find((l) => l.status === 'running');
  if (running) console.log(`\nLive output (${LABEL[running.agent]}):\n${readJobLog(running.job_id, 2500)}`);
}

const HELP = `relay ${VERSION}: when your AI agent runs out of usage, another one takes the baton.

Setup
  relay install [--only claude,codex,gemini,antigravity] [--no-autostart]
  relay uninstall
  relay doctor                         who is installed / usage-limited, waker, relays
  relay config [get <key> | set <key> <value> | path]

Relays
  relay list                           recent relays
  relay show <id>                      log + live output of a relay
  relay cancel <id>                    stop a relay and its running partner
  relay now <id>                       wake the primary agent right away
  relay handoff <claude|codex|gemini|auto> --baton notes.md [--task "..."] [--cwd .]
               [--resume after_reset|after_handoff|on_next_message|never] [--reset-at "3pm"] [--from claude]
  relay run "task" [--chain claude,codex,gemini] [--access write] [--cwd .] [--wait]

Internal: mcp, waker [--once], hook <stop-failure|session-start|user-prompt>, _job <id>, selftest`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const cwd = path.resolve(flags.cwd || process.cwd());

  switch (cmd) {
    case 'mcp': {
      const { serve } = await import('../src/core/mcp-server.mjs');
      const { TOOLS, call, instructions } = await import('../src/tools.mjs');
      return serve({ tools: TOOLS, call, instructions: instructions() });
    }
    case '_job':
      return runJobProcess(pos[0], OPS);
    case 'waker':
      return wakerLoop({ once: !!flags.once });
    case 'hook': {
      let input = {};
      try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
      const handler = { 'stop-failure': onStopFailure, 'session-start': onSessionStart, 'user-prompt': onUserPrompt }[pos[0]];
      try {
        const r = handler ? handler(input) : null;
        if (r) process.stdout.write(JSON.stringify(r));
      } catch (e) {
        process.stderr.write(`relay hook error: ${e.message}\n`);
      }
      return;
    }

    case 'install': {
      const { install } = await import('../src/install.mjs');
      console.log('Installing Relay…');
      await install({ only: list(flags.only), autostart: !flags['no-autostart'] });
      console.log('\nDone. Restart your agents (Claude Code, Codex, Gemini CLI, Antigravity) so they load the "relay" MCP server and skill.\nCheck with: relay doctor');
      return;
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/install.mjs');
      return uninstall();
    }
    case 'doctor':
    case 'status': {
      const s = status();
      const { installedTargets } = await import('../src/install.mjs');
      console.log(`Relay ${VERSION} · data ${APP_HOME}\n`);
      for (const a of s.agents) {
        const v = a.installed ? await agentVersion(a.agent) : null;
        const state = !a.installed ? 'not installed' : a.limited_until ? `LIMITED until ${fmtTime(a.limited_until)} (${fmtIn(a.limited_until)})` : 'available';
        console.log(`${LABEL[a.agent].padEnd(7)} ${state}${v ? ` · ${v}` : ''}${a.path ? `\n        ${a.path}` : ''}${a.usage ? `\n        usage: ${a.usage}` : ''}`);
      }
      const cfg = loadConfig();
      console.log(`\nAuto relay: ${cfg.enabled ? 'on' : 'off'} · fallback chain: ${cfg.fallback_chain.join(' → ')} · on reset: ${cfg.on_reset}`);
      console.log(`Wired into: ${installedTargets().join(', ') || 'nothing yet (run: relay install)'}`);
      console.log(`Waker: ${s.waker}\nRelays:\n${s.relays.map((x) => `  ${x}`).join('\n') || '  none'}`);
      return;
    }
    case 'config': {
      if (pos[0] === 'set') return out({ [pos[1]]: setConfigValue(pos[1], pos.slice(2).join(' ')) });
      if (pos[0] === 'path') return out(CONFIG_PATH);
      const c = loadConfig();
      return out(pos[1] ? pos[1].split('.').reduce((o, k) => o?.[k], c) : c);
    }

    case 'list':
      return console.log(listTickets().slice(0, 20).map(describeTicket).join('\n') || 'No relays.');
    case 'show':
      return showTicket(getTicket(pos[0]));
    case 'cancel':
      return showTicket(cancelTicket(pos[0]));
    case 'now':
      return showTicket(resumeNow(pos[0]));
    case 'handoff': {
      const baton = flags.baton && fs.existsSync(flags.baton) ? fs.readFileSync(flags.baton, 'utf8') : flags.baton || (await readStdin());
      const r = handoff({ to: pos[0], baton, task: flags.task, cwd, resume: flags.resume, access: flags.access, from: flags.from, reset_at: flags['reset-at'] });
      return console.log(r.ok ? `${r.message}\nRelay: ${r.ticket_id}` : `✖ ${r.message || r.error}`);
    }
    case 'run': {
      const r = autopilot({ task: pos.join(' ') || (await readStdin()), cwd, chain: list(flags.chain), access: flags.access });
      if (!r.ok) return console.log(`✖ ${r.error}`);
      console.log(`Relay ${r.ticket_id}: ${LABEL[r.primary]} is on it. Baton: ${r.baton_path}\nWatch: relay show ${r.ticket_id}`);
      if (flags.wait) {
        let t;
        do {
          await new Promise((res) => setTimeout(res, 15000));
          t = getTicket(r.ticket_id);
          process.stderr.write(`  ${describeTicket(t)}\n`);
        } while (t.state === 'active');
        console.log(t.legs.at(-1)?.summary || '(no summary)');
      }
      return;
    }

    case 'selftest': {
      const { selftest } = await import('../test/selftest.mjs');
      return selftest();
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return console.log(HELP);
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.log(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`relay: ${e.message || e}`);
  process.exitCode = 1;
});
