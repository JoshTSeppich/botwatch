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

test('a worktree written to after its snapshot is refused at merge, then snapshotted again', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'greet.js'), 'one\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);
  const first = run.workers[0].snapshot.sha;
  // The review is taken while the tree still matches the snapshot.
  const [r] = await run.reviewAll();
  assert.equal(r.sha, first);

  // Something the turn didn't wait for writes after the review, with no new turn.
  writeFileSync(join(f.wt, 'late.js'), 'late\n');
  run.userApprovedMerge = true;
  const out = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  assert.match(out.error, /worktree changed after the snapshot you reviewed/);
  assert.equal(existsSync(join(f.repo, 'greet.js')), false, 'nothing merged');

  // It is snapshotted again, and the old review no longer matches.
  await run.resnapshotAll();
  const second = run.workers[0].snapshot.sha;
  assert.notEqual(second, first);
  assert.equal(run.workers[0].changedAfterSnapshot.from, first);
  assert.match(git(f.wt, 'show', '--name-only', '--format=', second), /late\.js/);
  const again = await run.merge({ reviewed: [{ branch: r.branch, sha: r.sha }] });
  assert.match(again.error, /changed since you reviewed it/);

  // Reviewing the new snapshot is what lets it merge.
  const [fresh] = await run.reviewAll();
  const ok = await run.merge({ reviewed: [{ branch: fresh.branch, sha: fresh.sha }] });
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(readFileSync(join(f.repo, 'late.js'), 'utf8'), 'late\n');
});

test('a clean worktree is not snapshotted again, and a running worker never is', async () => {
  const f = fixture();
  writeFileSync(join(f.wt, 'greet.js'), 'one\n');
  const run = runWith(f);
  await run.snapshot(run.workers[0]);
  const sha = run.workers[0].snapshot.sha;
  assert.equal(await run.resnapshot(run.workers[0]), null);
  assert.equal(run.workers[0].snapshot.sha, sha);
  run.workers[0].state = 'running';
  writeFileSync(join(f.wt, 'more.js'), 'more\n');
  assert.equal(await run.resnapshot(run.workers[0]), null, 'its turn will snapshot it');
  assert.equal(run.workers[0].snapshot.sha, sha);
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

// Three worktrees off one repo: w1 and w3 both rewrite app.js, w2 is busy.
function three() {
  const f = fixture();
  const trees = { w1: f.wt };
  for (const id of ['w2', 'w3']) {
    trees[id] = join(f.root, id);
    git(f.repo, 'worktree', 'add', '-q', '-b', `bw/${id}-task`, trees[id]);
  }
  const run = new Run({ repo: f.repo, goal: 'g', model: 'haiku' });
  run.testWorktree = async () => ({ passed: true, exitCode: 0 });
  for (const id of ['w1', 'w2', 'w3']) {
    run.workers.push({ id, task: id, branch: `bw/${id}-task`, base: 'main', cwd: trees[id], state: 'done', doneAt: 1 });
  }
  return { ...f, trees, run };
}

test('a finished worker merges while another is still running, which is left untouched', async () => {
  const { repo, trees, run } = three();
  writeFileSync(join(trees.w1, 'one.js'), '1\n');
  await run.snapshot(run.workers[0]);
  const w2 = run.workers[1];
  w2.state = 'running';
  writeFileSync(join(trees.w2, 'wip.js'), 'half done\n');
  const w2TipBefore = git(repo, 'rev-parse', 'bw/w2-task');

  const reviews = await run.reviewAll();
  const r1 = reviews.find((r) => r.id === 'w1');
  run.userApprovedMerge = true;
  const out = await run.merge({ reviewed: [{ branch: r1.branch, sha: r1.sha }] });
  assert.equal(out.error, undefined, out.error);

  assert.match(git(repo, 'log', '-1', '--format=%s', 'main'), /merge bw\/w1-task \(w1 @/);
  assert.equal(git(repo, 'rev-parse', 'bw/w2-task'), w2TipBefore, "w2's branch did not move");
  assert.equal(git(trees.w2, 'status', '--porcelain'), '?? wip.js', "w2's work in progress is still there");

  // And the running one cannot be merged, whatever the click says.
  const r2 = reviews.find((r) => r.id === 'w2');
  assert.match((await run.merge({ reviewed: [{ branch: r2.branch, sha: r2.sha }] })).error, /has not finished/);
  // Nor can w1 merge a second time.
  assert.match((await run.merge({ reviewed: [{ branch: r1.branch, sha: r1.sha }] })).error, /already merged/);
});

test('a later merge that conflicts with one that landed is aborted cleanly', async () => {
  const { repo, trees, run } = three();
  writeFileSync(join(trees.w1, 'app.js'), 'export const a = "w1";\n');
  writeFileSync(join(trees.w3, 'app.js'), 'export const a = "w3";\n');
  await run.snapshot(run.workers[0]);
  await run.snapshot(run.workers[2]);
  const reviews = await run.reviewAll();
  const pick = (id) => reviews.filter((r) => r.id === id).map((r) => ({ branch: r.branch, sha: r.sha }));
  run.userApprovedMerge = true;

  assert.equal((await run.merge({ reviewed: pick('w1') })).error, undefined);
  const afterW1 = git(repo, 'rev-parse', 'main');
  const out = await run.merge({ reviewed: pick('w3') });
  assert.equal(out.error, 'merge of bw/w3-task failed: conflicts with what is already on your branch in app.js. Nothing was changed.');
  assert.deepEqual(out.conflicted, ['app.js']);
  assert.equal(git(repo, 'rev-parse', 'main'), afterW1, 'main is where w1 left it');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'no conflict left in the checkout');
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false);
  assert.equal(readFileSync(join(repo, 'app.js'), 'utf8'), 'export const a = "w1";\n');
});

test("after one worker's branch merges, another's review still shows only its own changes", async () => {
  const f = fixture();
  const w2 = join(f.root, 'w2');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'bw/w2-task', w2);
  writeFileSync(join(f.wt, 'one.js'), '1\n');
  writeFileSync(join(w2, 'two.js'), '2\n');
  const run = runWith(f);
  run.workers.push({ id: 'w2', task: 't', branch: 'bw/w2-task', base: 'main', cwd: w2, state: 'done', doneAt: 1 });
  await run.snapshot(run.workers[0]);
  await run.snapshot(run.workers[1]);
  const before = await review(w2, 'main');
  run.userApprovedMerge = true;
  const [r1] = (await run.reviewAll()).filter((r) => r.id === 'w1');
  assert.equal((await run.merge({ reviewed: [{ branch: r1.branch, sha: r1.sha }] })).error, undefined);

  const after = await review(w2, 'main');
  assert.deepEqual(after, before, 'main moving on does not change what w2 brings');
  assert.deepEqual(after.added.map((e) => e.file), ['two.js']);
  assert.equal([...after.edits, ...after.added].some((e) => e.file === 'one.js'), false, "w1's file is not shown as removed by w2");
});

test('Review in terminal shows exactly the reviewed commit, from where its branch left main', async () => {
  const f = fixture();
  const w2 = join(f.root, 'w2');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'bw/w2-task', w2);
  writeFileSync(join(f.wt, 'one.js'), '1\n');
  writeFileSync(join(w2, 'two.js'), 'export const two = 2;\n');
  const run = runWith(f);
  run.workers.push({ id: 'w2', task: 't', branch: 'bw/w2-task', base: 'main', cwd: w2, state: 'done', doneAt: 1 });
  await run.snapshot(run.workers[0]);
  await run.snapshot(run.workers[1]);
  const reviews = await run.reviewAll();
  run.userApprovedMerge = true;
  const r1 = reviews.find((r) => r.id === 'w1');
  await run.merge({ reviewed: [{ branch: r1.branch, sha: r1.sha }] });

  const r2 = reviews.find((r) => r.id === 'w2');
  const built = await run.diffCommand(r2.branch, r2.sha);
  assert.equal(built.error, undefined, built.error);
  assert.match(built.command, /--no-ext-diff --no-textconv/);
  const { execSync } = await import('node:child_process');
  const out = execSync(built.command, { shell: '/bin/sh', encoding: 'utf8', env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' } });
  assert.match(out, /two\.js/);
  assert.match(out, /\+export const two = 2;/);
  assert.doesNotMatch(out, /one\.js/, "w1's merged change is not part of w2's diff");

  assert.match((await run.diffCommand('main', r2.sha)).error, /not a branch of this run/);
  assert.match((await run.diffCommand(r2.branch, r1.sha)).error, /is not on bw\/w2-task/);
  assert.match((await run.diffCommand(r2.branch, '$(rm -rf ~)')).error, /not a commit/);
  clearInterval(run.reaper);
});
