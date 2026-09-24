// How a process outside BotWatch runs one of BotWatch's scripts: the guard
// hook every spawned session calls, and the orchestrator's MCP server.
//
// Two things break in a packaged app that don't in a checkout. The script sits
// inside app.asar, which nothing but Electron can read, so these files ship
// unpacked (package.json asarUnpack) and the path is rewritten to match. And
// `node` may not be on the user's PATH at all, so the script runs on the app's
// own binary in node mode.

import { fileURLToPath } from 'node:url';

export function scriptPath(url) {
  return fileURLToPath(url).replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

// { command, args, env } for spawn-style callers such as an MCP config.
export function scriptCommand(url) {
  return {
    command: process.execPath,
    args: [scriptPath(url)],
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

// The same, as one shell command line, for a settings hook.
export function scriptShellCommand(url) {
  const { command, args, env } = scriptCommand(url);
  const prefix = Object.entries(env).map(([k, v]) => `${k}=${v} `).join('');
  return `${prefix}${[command, ...args].map((part) => JSON.stringify(part)).join(' ')}`;
}
