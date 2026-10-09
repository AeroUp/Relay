// Ways to watch a relay while it runs: the local live viewer (every agent), and the
// agent's own desktop app when it can show headless runs (Codex threads open in the
// ChatGPT/Codex app through codex://threads/<id>).
import path from 'node:path';
import { APP_HOME, readJSON, pidAlive, spawnDetached } from './core/util.mjs';
import { loadConfig } from './core/config.mjs';

export const VIEWER_PID = path.join(APP_HOME, 'viewer.pid');

export function viewerUrl(ticketId) {
  const cfg = loadConfig();
  let host = cfg.viewer_host && cfg.viewer_host !== '0.0.0.0' && cfg.viewer_host !== '::' ? cfg.viewer_host : '127.0.0.1';
  if (host.includes(':')) host = `[${host}]`;
  return `http://${host}:${cfg.viewer_port}/${ticketId ? `#${ticketId}` : ''}`;
}

export function appLink(leg) {
  if (leg?.agent === 'codex' && /^[\w-]{8,80}$/.test(leg.session_id || '')) return `codex://threads/${leg.session_id}`;
  return null;
}

export const APP_NAME = { codex: 'ChatGPT' };

export function viewerRunning() {
  const v = readJSON(VIEWER_PID);
  return v && pidAlive(v.pid) ? v : null;
}

/** Start the viewer in the background if it isn't running. */
export function ensureViewer() {
  if (!loadConfig().viewer_port || viewerRunning()) return false;
  spawnDetached(['_viewer'], { logFile: path.join(APP_HOME, 'viewer.log') });
  return true;
}

/** Toast options for a relay: click to watch live, plus "Open in ChatGPT" for Codex legs. */
export function watchLinks(ticketId, leg) {
  const url = loadConfig().viewer_port ? viewerUrl(ticketId) : null;
  const app = appLink(leg);
  return {
    url: url || app,
    actions: [url && { label: 'Watch live', url }, app && { label: `Open in ${APP_NAME[leg.agent]}`, url: app }].filter(Boolean),
  };
}
