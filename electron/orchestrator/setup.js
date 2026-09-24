// What the setup panel offers: repos you're already working in, the models,
// the most a worker may be allowed, and the test command the review will run.
// Nothing here is invented — each list comes from something on disk.

import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { detectTestCommand } from './testrun.js';

const execFile = promisify(execFileCb);

export const MODELS = ['haiku', 'sonnet', 'opus'];
export const PERMISSIONS = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

// Git roots of the sessions you have open, most recent first, deduplicated.
export async function recentRepos(sessions) {
  const roots = [];
  const ordered = [...sessions].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const s of ordered) {
    const root = await execFile('git', ['-C', s.repo, 'rev-parse', '--show-toplevel'])
      .then(({ stdout }) => stdout.trim())
      .catch(() => null);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots.slice(0, 5);
}

// What the panel offers, and what it starts on. Never wider than your own
// mode; and starting on acceptEdits even when you run bypass yourself, so
// anything wider is a choice you make, not one the panel made for you.
export function permissionChoices(ceiling) {
  const offered = PERMISSIONS.slice(0, PERMISSIONS.indexOf(ceiling) + 1);
  const start = offered.includes('acceptEdits') ? 'acceptEdits' : offered[offered.length - 1];
  return { offered, start };
}

// "Never wider than the user's own": the mode your own sessions start in.
export async function userCeiling() {
  const settings = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  const mode = settings?.permissions?.defaultMode;
  return PERMISSIONS.includes(mode) ? mode : 'default';
}

export async function setupInfo(repo, sessions) {
  const repos = await recentRepos(sessions);
  const chosen = repo || repos[0] || null;
  const ceiling = await userCeiling();
  return {
    repos,
    repo: chosen,
    models: MODELS,
    ceiling,
    ...permissionChoices(ceiling),
    testCommand: chosen ? await detectTestCommand(chosen) : null,
  };
}
