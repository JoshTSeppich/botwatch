// Runs every integration script against the real CLI, one after another, and
// says which passed. Spends tokens. Run it at the end of every phase: these
// are the guarantees that must not regress.
//
//   node tools/it-all.mjs [name ...]
//
// Scripts that take a repo get a fresh scratch one each, outside the temp
// directory (the sandbox always lets a shell write there, which would hide
// what it does to a real worktree), and it is deleted afterwards.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// name -> whether it takes a repo argument.
const SCRIPTS = [
  ['smoke-worker', true],
  ['it-spawn', true],
  ['it-message', true],
  ['it-diff', true],
  ['it-reap', true],
  ['it-waitfor', false],
  ['it-mcp', false],
  ['it-recovery', false],
  ['it-pause', false],
  ['it-snapshot', false],
  ['it-escape', false],
];

function scratchRepo() {
  const root = mkdtempSync(join(homedir(), '.bw-it-all-'));
  const repo = join(root, 'greeter');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'greeter', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  writeFileSync(join(repo, 'src/greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  writeFileSync(
    join(repo, 'test/greet.test.js'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { greet } from '../src/greet.js';\n\ntest('greet', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n",
  );
  git('add', '-A');
  git('-c', 'user.email=it@example.com', '-c', 'user.name=IT', 'commit', '-q', '-m', 'greeter');
  return { root, repo };
}

const wanted = process.argv.slice(2);
const results = [];
for (const [name, takesRepo] of SCRIPTS) {
  if (wanted.length && !wanted.includes(name)) continue;
  const scratch = takesRepo ? scratchRepo() : null;
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const r = spawnSync(process.execPath, [new URL(`./${name}.mjs`, import.meta.url).pathname, ...(scratch ? [scratch.repo] : [])], {
    stdio: 'inherit',
    timeout: 20 * 60_000,
  });
  if (scratch) rmSync(scratch.root, { recursive: true, force: true });
  results.push({ name, ok: r.status === 0, status: r.status ?? r.signal, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log('\nSummary');
for (const r of results) console.log(`  ${r.ok ? 'pass' : 'FAIL'} ${r.name} (${r.seconds}s${r.ok ? '' : `, exit ${r.status}`})`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
