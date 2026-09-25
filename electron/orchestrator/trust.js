// Take over counts as the user saying yes to Claude Code's "Is this a project
// you trust?" for that worker's worktree — a checkout of a repo they chose to
// orchestrate — so the resumed session opens on the conversation instead of
// stopping at the prompt.
//
// ~/.claude.json is Claude Code's own file and running sessions write it too,
// so this touches one key only, re-reads right before writing, writes a temp
// file and renames it into place, and refuses to write anything if the file
// doesn't parse.

import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_CONFIG = join(homedir(), '.claude.json');

export function trustFolder(path, { configPath = CLAUDE_CONFIG } = {}) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return { error: `no such folder: ${path}` };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { error: `${configPath} could not be read as JSON; left untouched` };
  }
  config.projects ??= {};
  const entry = config.projects[real] ?? {};
  if (entry.hasTrustDialogAccepted === true) return { trusted: real, changed: false };
  config.projects[real] = { ...entry, hasTrustDialogAccepted: true };

  const mode = statSync(configPath).mode & 0o777;
  const temp = `${configPath}.botwatch-${process.pid}`;
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode });
  renameSync(temp, configPath);
  return { trusted: real, changed: true };
}
