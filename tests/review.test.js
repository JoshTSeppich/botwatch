// Review and merge against real git repositories: what the user is shown is
// what merges, a new file is never filed as an edit, and a failed merge leaves
// the checkout as it was.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { review } from '../electron/orchestrator/review.js';
import { Run } from '../electron/orchestrator/run.js';
import { detectTestCommand, runTests } from '../electron/orchestrator/testrun.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// A repo on main with one file, and a worker worktree on bw/w1-task.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bw-review-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'app.js'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'bw/w1-task', wt);
  return { root, repo, wt };
}

// A Run with one finished worker in the fixture's worktree, and tests stubbed.
function runWith({ repo, wt }, testCommand = null) {
  const run = new Run({ repo, goal: 'g', model: 'haiku', testCommand });
  run.workers.push({ id: 'w1', task: 'Add greet. Then test it.', branch: 'bw/w1-task', base: 'main', cwd: wt, state: 'done', doneAt: 1 });
  run.testWorktree = async () => ({ command: testCommand, passed: true, exitCode: 0 });
  return run;
}

test('after a snapshot, new files are still new files and edits are still edits', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'app.js'), 'export const a = 2;\nexport const b = 3;\n');
  writeFileSync(join(f.wt, 'greet.js'), 'export const greet = () => "hi";\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);

  const r = await review(f.wt, 'main');
  assert.deepEqual(r.edits.map((e) => e.file), ['app.js']);
  assert.deepEqual(r.added.map((e) => [e.file, e.added]), [['greet.js', 1]]);
  assert.equal(r.safe, true);
});

test('a .env and build output left behind are flagged, by name, as new files', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, '.env'), 'API_KEY=dev\n');
  mkdirSync(join(f.wt, 'dist'));
  writeFileSync(join(f.wt, 'dist', 'app.js'), 'bundled();\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);

  const r = await review(f.wt, 'main');
  assert.deepEqual(r.added.map((e) => e.file).sort(), ['.env', 'dist/app.js']);
  assert.deepEqual(r.flagged, [
    { file: '.env', reason: 'environment file' },
    { file: 'dist/app.js', reason: 'build output' },
  ]);
});

test('the snapshot records its commit and time, and the test result is for that commit', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'greet.js'), 'x\n');
  const run = runWith(f, 'npm test');
  let testedAt = null;
  run.testWorktree = async () => {
    testedAt = git(f.wt, 'rev-parse', 'HEAD');
    return { command: 'npm test', sha: testedAt, passed: false, exitCode: 1 };
  };
  await run.snapshot(run.workers[0]);
  const w = run.workers[0];
  assert.equal(w.snapshot.sha, git(f.repo, 'rev-parse', 'bw/w1-task'));
  assert.equal(testedAt, w.snapshot.sha, 'tests ran against the snapshot');
  assert.ok(w.snapshot.at > 0);
  assert.equal(w.test.passed, false);

  const [r] = await run.reviewAll();
  assert.equal(r.sha, w.snapshot.sha);
  assert.equal(r.test.exitCode, 1);
});

test('merge brings in the reviewed commit once its flags are acknowledged', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'greet.js'), 'export const greet = 1;\n');
  writeFileSync(join(f.wt, '.env'), 'API_KEY=dev\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);
  const [r] = await run.reviewAll();
  run.userApprovedMerge = true;

  const out = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }], acknowledged: ['w1:.env'] });
  assert.equal(out.error, undefined, out.error);
  assert.equal(readFileSync(join(f.repo, 'greet.js'), 'utf8'), 'export const greet = 1;\n');
  assert.match(git(f.repo, 'log', '-1', '--format=%s'), /merge bw\/w1-task \(w1 @ [0-9a-f]{7}\)/);
});

test('a branch that moved after the review is not merged', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'greet.js'), 'one\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);
  const [r] = await run.reviewAll();

  // The worker ran another turn after the user looked.
  writeFileSync(join(f.wt, 'greet.js'), 'two\n');
  run.workers[0].doneAt = 2;
  await run.snapshot(run.workers[0]);

  run.userApprovedMerge = true;
  const out = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  assert.match(out.error, /changed since you reviewed it/);
  assert.equal(existsSync(join(f.repo, 'greet.js')), false);
});

test('a conflicting merge is aborted, leaving the checkout as it was', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'app.js'), 'export const a = "worker";\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);
  const [r] = await run.reviewAll();
  writeFileSync(join(f.repo, 'app.js'), 'export const a = "user";\n');
  git(f.repo, 'commit', '-q', '-am', 'user edit');
  const before = git(f.repo, 'rev-parse', 'HEAD');

  run.userApprovedMerge = true;
  const out = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  assert.match(out.error, /merge of bw\/w1-task failed/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.repo, 'status', '--porcelain'), '', 'no conflict markers left behind');
});

test('a checkout already mid-merge is refused, not aborted', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'greet.js'), 'x\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);
  const [r] = await run.reviewAll();
  writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), `${git(f.repo, 'rev-parse', 'HEAD')}\n`);

  run.userApprovedMerge = true;
  const out = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  assert.match(out.error, /middle of a merge/);
  assert.equal(existsSync(join(f.repo, '.git', 'MERGE_HEAD')), true, "the user's merge is untouched");
});

test('the test command is detected the way a user would type it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-detect-'));
  assert.equal(await detectTestCommand(dir), null);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(await detectTestCommand(dir), null, "npm init's placeholder is not a test suite");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal(await detectTestCommand(dir), 'npm test');
});

test('tests run with no network and no writes outside the worktree', { skip: process.platform !== 'darwin' && 'Seatbelt is macOS only' }, async () => {
  const f = fixture();
  const escape = join(homedir(), `.bw-escape-${process.pid}`);
  const result = await runTests(
    f.wt,
    `echo in > inside.txt && (echo out > ${escape} && echo WROTE-OUTSIDE || true) && (curl -s -m 3 https://example.com >/dev/null && echo NETWORK || true)`,
  );
  assert.equal(result.passed, true, result.tail);
  assert.equal(result.sandboxed, true);
  assert.equal(existsSync(join(f.wt, 'inside.txt')), true);
  assert.equal(existsSync(escape), false, 'a write outside the worktree was blocked');
  assert.doesNotMatch(result.tail, /WROTE-OUTSIDE|NETWORK/);
});

test('a failing test command is a result, with its exit code and output', async () => {
  const f = fixture();
  const result = await runTests(f.wt, 'echo broken; exit 3');
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.tail, /broken/);
  assert.equal(result.sha, git(f.wt, 'rev-parse', 'HEAD'));
});

test('a worker gets the mode chosen in setup unless the orchestrator asks for less', async () => {
  const f = fixture();
  const run = new Run({ repo: f.repo, goal: 'g', model: 'haiku', permissionCeiling: 'acceptEdits' });
  run.limits.maxWorkers = 0; // queue them, so nothing is started
  await run.spawn('one');
  await run.spawn('two', 'haiku', 'plan');
  await run.spawn('three', 'haiku', 'bypassPermissions');
  assert.deepEqual(run.workers.map((w) => w.permissionMode), ['acceptEdits', 'plan', 'acceptEdits']);
  clearInterval(run.reaper);
});

test('setup starts on acceptEdits even for a bypass user, and never offers above their own mode', async () => {
  const { permissionChoices } = await import('../electron/orchestrator/setup.js');
  assert.deepEqual(permissionChoices('bypassPermissions'), {
    offered: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
    start: 'acceptEdits',
  });
  assert.deepEqual(permissionChoices('default'), { offered: ['plan', 'default'], start: 'default' });
});
