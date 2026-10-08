// Wire Relay into every agent on this machine: MCP server, skill, Claude Code hooks,
// and a login item so pending relays survive a reboot.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, IS_WIN, APP_HOME, CLI, ensureDir, readJSON, writeJSON } from './core/util.mjs';
import {
  detect, claudeAddMcp, claudeRemoveMcp, claudeSetHooks, codexAddMcp, codexRemoveMcp, jsonAddMcp, jsonRemoveMcp,
  GEMINI_SETTINGS, ANTIGRAVITY_MCP, SKILL_DIRS, installSkills, removeSkills,
} from './core/install-kit.mjs';

const SKILLS = ['relay'];
const RECORD = path.join(APP_HOME, 'install.json');
const HOOKS = {
  StopFailure: { arg: 'stop-failure', timeout: 60 }, // a turn died on an API error → relay on usage limits
  SessionStart: { arg: 'session-start', timeout: 10 }, // revive the waker if relays are pending
  UserPromptSubmit: { arg: 'user-prompt', timeout: 10 }, // the human is back → deliver partner reports
};

// ---- Login item: run `relay waker` once at login (it exits when idle) ------------

function loginItem() {
  if (IS_WIN) {
    return {
      file: path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'relay-waker.vbs'),
      body: `' Relay: resume pending relays after login (exits immediately when there is nothing to do)\r\nCreateObject("WScript.Shell").Run """${process.execPath}"" ""${CLI}"" waker", 0, False\r\n`,
    };
  }
  if (process.platform === 'darwin') {
    return {
      file: path.join(HOME, 'Library', 'LaunchAgents', 'com.aeroup.relay.waker.plist'),
      body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aeroup.relay.waker</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${CLI}</string><string>waker</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
    };
  }
  return {
    file: path.join(HOME, '.config', 'autostart', 'relay-waker.desktop'),
    body: `[Desktop Entry]\nType=Application\nName=Relay waker\nExec="${process.execPath}" "${CLI}" waker\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`,
  };
}

export async function install({ only, autostart = true } = {}) {
  const log = (l) => l && console.log(`  ${l}`);
  const want = (k) => (!only || only.includes(k)) && detect[k]();
  const rec = { at: new Date().toISOString(), targets: [] };
  ensureDir(APP_HOME);
  if (want('claude')) {
    log(await claudeAddMcp());
    log(claudeSetHooks(HOOKS));
    rec.targets.push('claude');
  }
  if (want('codex')) { log(codexAddMcp()); rec.targets.push('codex'); }
  if (want('gemini')) {
    jsonAddMcp(GEMINI_SETTINGS, 'gemini', { timeout: 3600000, trust: false });
    log(`Gemini CLI: MCP server added to ${GEMINI_SETTINGS}`);
    rec.targets.push('gemini');
  }
  if (want('antigravity')) {
    jsonAddMcp(ANTIGRAVITY_MCP, 'antigravity');
    log(`Antigravity: MCP server added to ${ANTIGRAVITY_MCP}`);
    rec.targets.push('antigravity');
  }
  for (const k of ['claude', 'codex', 'gemini', 'antigravity']) {
    if (!rec.targets.includes(k) && (!only || only.includes(k))) log(`${k}: not found, skipped (install it, run it once, then run install again)`);
  }
  for (const t of rec.targets) installSkills(SKILL_DIRS[t], SKILLS);
  log(`Skill "relay" → ${rec.targets.map((t) => SKILL_DIRS[t]).join(', ')}`);
  if (autostart) {
    const { file, body } = loginItem();
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, body);
    rec.login_item = file;
    log(`Login item: pending relays resume after a reboot (${file})`);
  }
  writeJSON(RECORD, rec);
}

export async function uninstall() {
  const log = (l) => l && console.log(`  ${l}`);
  if (detect.claude()) {
    log(await claudeRemoveMcp());
    log(claudeSetHooks(null));
  }
  log(codexRemoveMcp());
  if (jsonRemoveMcp(GEMINI_SETTINGS)) log('Gemini CLI: MCP server removed');
  if (jsonRemoveMcp(ANTIGRAVITY_MCP)) log('Antigravity: MCP server removed');
  for (const base of Object.values(SKILL_DIRS)) for (const p of removeSkills(base, SKILLS)) log(`removed skill ${p}`);
  const { file } = loginItem();
  if (fs.existsSync(file)) { fs.unlinkSync(file); log('Login item removed'); }
  log(`Done. Data in ${APP_HOME} was kept; delete it by hand if you want.`);
}

export const installedTargets = () => readJSON(RECORD, {}).targets || [];
