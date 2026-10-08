// What makes this package Relay. Everything in src/core/ is shared with Tag-Team
// (https://github.com/AeroUp/Tag-Team) and reads its identity from this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = 'relay'; // MCP server name, data dir name
export const TITLE = 'Relay';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'bin', 'relay.mjs');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const APP_HOME = process.env.RELAY_HOME || path.join(os.homedir(), '.relay');

export const DEFAULTS = {
  // Relay automatically when Claude Code stops on a usage limit.
  enabled: true,
  // Who picks up the work while the primary agent is rate-limited, in order.
  fallback_chain: ['codex', 'gemini', 'claude'],
  // Start a fallback agent automatically when a limit is hit (false = only wait and resume).
  auto_fallback: true,
  // When the primary's limit resets while the fallback is still working:
  //   "wait"     – let the fallback finish, then resume the primary to review + finish
  //   "takeover" – stop the fallback and resume the primary right away
  //   "none"     – never resume the primary; the fallback owns the task
  on_reset: 'wait',
  resume_buffer_sec: 90,
  // Access for unattended runs when the session asked before every action
  // ("read" | "write" | "full"). Accept-edits sessions get write, bypass sessions get full.
  default_access: 'write',
  // Plain 429 / overloaded errors: retry the same agent after this many minutes.
  transient_retry_min: 4,
  max_legs: 8,
};
