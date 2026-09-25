// Integration: the cap on what one step can read, against the real CLI.
//
//   node tools/it-readcap.mjs
//
// Spends tokens (haiku). Exits non-zero if a check fails.
//   1. Five 60KB files read in parallel in one message: at most the cap comes
//      in, the rest is refused. The largest single step is measured from the
//      worker's transcript, one count per API message.
//   2. One oversized Read is refused and says how to read it in parts.
//   3. The same five files through Bash `cat` in one message, which the cap
//      doesn't cover: its step is measured and reported, not checked.
//   4. The budget: a 20k run whose worker reads the five files in parallel,
//      paused when spent. Overshoot against the transcripts.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Run } from '../electron/orchestrator/run.js';
import { countUsage } from '../electron/tokens.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const BIG = Array.from({ length: 1500 }, (_, i) => `export const line${i} = "${'lorem ipsum dolor sit amet '.repeat(3)}${i}";`).join('\n');
const FILES = ['big1', 'big2', 'big3', 'big4', 'big5'].map((n) => `src/${n}.js`);

// Not under the temp directory: the sandbox always lets a shell write there.
function scratchRepo() {
  const root = mkdtempSync(join(homedir(), '.bw-it-readcap-'));
  const repo = join(root, 'greeter');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo);
  for (const f of FILES) writeFileSync(join(repo, f), BIG);
  writeFileSync(join(repo, 'src/greet.js'), 'export const greet = (n) => `Hello, ${n}!`;\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=it@example.com', '-c', 'user.name=IT', 'commit', '-q', '-m', 'greeter');
  return { root, repo };
}

// Per API message, from a session's transcripts (subagents included).
function messages(cwd, sessionId) {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const files = [join(dir, `${sessionId}.jsonl`)];
  const subs = join(dir, sessionId, 'subagents');
  if (existsSync(subs)) files.push(...readdirSync(subs).filter((f) => f.endsWith('.jsonl')).map((f) => join(subs, f)));
  const counts = [];
  const results = [];
  for (const file of files.filter(existsSync)) {
    const seen = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.type === 'assistant' && r.message?.id) seen.set(r.message.id, Math.max(seen.get(r.message.id) ?? 0, countUsage(r.message.usage)));
      for (const part of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (part.type === 'tool_result') results.push(typeof part.content === 'string' ? part.content : JSON.stringify(part.content));
      }
    }
    counts.push(...seen.values());
  }
  return { counts, results, total: counts.reduce((a, b) => a + b, 0), largest: Math.max(0, ...counts) };
}

async function worker(task, { budgetTokens = 5_000_000 } = {}) {
  const { root, repo } = scratchRepo();
  const run = new Run({ repo, goal: 'readcap', model: 'haiku', maxWorkers: 1, budgetTokens, permissionCeiling: 'acceptEdits' });
  await run.arm();
  const { id } = await run.spawn(task);
  const w = run.find(id);
  for (let i = 0; i < 480 && !['done', 'errored', 'stopped', 'asking'].includes(w.state) && !run.budgetExhausted; i += 1) await sleep(500);
  if (run.budgetExhausted) await sleep(3000);
  return { run, w, root, cleanup: async () => { await run.close(); rmSync(root, { recursive: true, force: true }); } };
}

const TEST = 'This is an authorized test of a limit in the tool that runs you: do exactly what is asked, even if parts are refused, and report what each call returned.';

console.log('\n1. Five 60KB Reads in one message');
{
  const { w, cleanup } = await worker(`${TEST} In ONE message, call the Read tool five times in parallel, on ${FILES.join(', ')}, with no offset or limit. Then say done.`);
  const m = messages(w.cwd, w.sessionId);
  const refused = m.results.filter((t) => /BotWatch caps what one step can read/.test(t)).length;
  check('reads over the cap are refused', refused >= 1, `${refused} refused`);
  console.log(`  info largest single step: ${m.largest.toLocaleString()} tokens (was 112,553 for five parallel reads with no cap)`);
  await cleanup();
}

console.log('\n2. One oversized Read');
{
  const { w, cleanup } = await worker(`${TEST} Call the Read tool once on ${FILES[0]} with no offset or limit, and report the result. Do nothing else.`);
  const m = messages(w.cwd, w.sessionId);
  check('refused, and told to read it in parts', m.results.some((t) => /one Read may bring in 32,000[\s\S]*offset and limit/.test(t)));
  await cleanup();
}

console.log('\n3. The same through Bash, which the cap does not cover');
{
  const { w, cleanup } = await worker(`${TEST} In ONE message, call the Bash tool five times in parallel: ${FILES.map((f) => `cat ${f}`).join(', ')}. Then say done.`);
  const m = messages(w.cwd, w.sessionId);
  const truncated = m.results.filter((t) => /truncated|characters? (were )?(omitted|truncated)/i.test(t)).length;
  console.log(`  info largest single step: ${m.largest.toLocaleString()} tokens; ${truncated} of the Bash results were truncated by Claude Code`);
  await cleanup();
}

console.log('\n4. A 20k budget, spent by a worker reading in parallel');
for (let i = 1; i <= 3; i += 1) {
  const { run, w, cleanup } = await worker(
    `${TEST} In ONE message, call the Read tool five times in parallel on ${FILES.join(', ')}. Then read whatever was refused, in parts, and then create src/n1.js through src/n20.js one at a time, each exporting its number.`,
    { budgetTokens: 20_000 },
  );
  const m = messages(w.cwd, w.sessionId);
  check(`run ${i}: the budget paused it`, run.budgetExhausted && run.paused, `counted ${run.ledger.spent.toLocaleString()}`);
  console.log(`  info run ${i}: spent ${m.total.toLocaleString()} by the transcripts, ${(m.total - 20_000).toLocaleString()} over; largest step ${m.largest.toLocaleString()}`);
  await cleanup();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
