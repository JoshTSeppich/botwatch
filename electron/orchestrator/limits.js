// The plan's weekly window as the CLI last reported it. Every worker and
// orchestrator emits a rate_limit_event in its stream (utilization is a
// fraction of the week, not tokens), so pilld keeps the newest one, with the
// time it was seen, instead of spending ~24k tokens on a probe to ask.

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LIMITS_PATH = join(homedir(), '.claude', 'botwatch', 'limits.json');

export async function readLimits(path = LIMITS_PATH) {
  return readFile(path, 'utf8').then(JSON.parse).catch(() => null);
}

export async function saveLimits({ fiveHour, sevenDay }, { path = LIMITS_PATH, now = Date.now() } = {}) {
  if (!sevenDay || !Number.isFinite(sevenDay.utilization)) return false;
  await writeFile(path, JSON.stringify({ fiveHour: fiveHour ?? null, sevenDay, at: now }), { mode: 0o600 });
  return true;
}
