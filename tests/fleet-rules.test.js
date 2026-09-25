// v4's pure rules: claims, leases, the decision log, and the merge queue
// against real git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as claims from '../electron/fleet/claims.js';
import { createDecisionLog } from '../electron/fleet/decisions.js';
import { grantable, leaseLive } from '../electron/fleet/leases.js';
import { MergeQueue } from '../electron/fleet/queue.js';

// ---- claims -------------------------------------------------------------------

test('claims are repo-relative globs; anything else is refused', () => {
  assert.equal(claims.normalize('src/ui/'), 'src/ui/**');
  assert.equal(claims.normalize('/etc/passwd'), null);
  assert.equal(claims.normalize('../other'), null);
  assert.equal(claims.normalize('a/../../b'), null);
});

test('glob matching: ** any depth, * one segment, a bare directory claims what is under it', () => {
  assert.ok(claims.matches('packages/ui/theme/colors.ts', ['packages/ui/theme/**']));
  assert.ok(claims.matches('packages/ui/theme', ['packages/ui/theme/**']));
  assert.ok(!claims.matches('packages/ui/button.ts', ['packages/ui/theme/**']));
  assert.ok(claims.matches('src/a.js', ['src/*.js']));
  assert.ok(!claims.matches('src/x/a.js', ['src/*.js']));
  assert.ok(claims.matches('src/x/a.js', ['src']));
});

test('overlap is conservative: it may see one that is not there, never miss one', () => {
  assert.ok(claims.overlaps('src/**', 'src/ui/**'));
  assert.ok(claims.overlaps('src/ui/a.ts', 'src/**'));
  assert.ok(claims.overlaps('src/*.ts', 'src/*.js'), 'two wildcards in one directory: called an overlap');
  assert.ok(!claims.overlaps('src/**', 'docs/**'));
  assert.ok(!claims.overlaps('src/a.js', 'src/b.js'));
});

// ---- leases -------------------------------------------------------------------

test('a grant is exact: the leases plus the hypervisor never exceed the global budget', () => {
  const state = { budgetTokens: 100, maxSessions: 4, hypervisorSpent: 10, leases: new Map([['O1', { tokens: 60, spent: 5 }]]) };
  assert.equal(grantable(state, 'O2', { tokens: 30, slots: 1, expiresAt: 2 }, 1).ok, true);
  const over = grantable(state, 'O2', { tokens: 31, slots: 1, expiresAt: 2 }, 1);
  assert.equal(over.ok, false);
  assert.match(over.reason, /at most 30/);
  assert.equal(grantable(state, 'O1', { tokens: 4, slots: 1, expiresAt: 2 }, 1).ok, false, 'not below what it spent');
  assert.equal(grantable(state, 'O2', { tokens: 1.5, slots: 1, expiresAt: 2 }, 1).ok, false);
  assert.equal(grantable(state, 'O2', { tokens: 10, slots: 5, expiresAt: 2 }, 1).ok, false, 'slots within the session cap');
  assert.equal(grantable(state, 'O2', { tokens: 10, slots: 1, expiresAt: 1 }, 1).ok, false, 'expiry in the future');
});

test('a lease is live until it expires, is revoked, or is spent', () => {
  assert.equal(leaseLive({ tokens: 10, spent: 0, expiresAt: 5 }, 4).ok, true);
  assert.equal(leaseLive({ tokens: 10, spent: 0, expiresAt: 5 }, 5).ok, false);
  assert.equal(leaseLive({ tokens: 10, spent: 10, expiresAt: 5 }, 1).ok, false);
  assert.equal(leaseLive({ tokens: 10, spent: 0, expiresAt: 5, revoked: true }, 1).ok, false);
  assert.equal(leaseLive(undefined, 1).ok, false);
});

test('the decision log is append-only JSON lines and survives a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-dec-'));
  const log = createDecisionLog(join(dir, 'd.jsonl'));
  log.record({ by: 'H', level: 'H', chain: 'H › O1', kind: 'answer', text: 'yes', rule: '' });
  assert.equal(log.list()[0].rule, null, 'no rule given is recorded as none');
  const again = createDecisionLog(join(dir, 'd.jsonl'));
  assert.equal(again.list().length, 1);
  assert.equal(readFileSync(join(dir, 'd.jsonl'), 'utf8').trim().split('\n').length, 1);
});

// ---- the merge queue, against real git -------------------------------------------

function repoWithBranches() {
  const root = mkdtempSync(join(tmpdir(), 'bw-queue-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const branch = (name, file, text) => {
    git('checkout', '-q', '-b', name, 'main');
    writeFileSync(join(repo, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return { branch: name, sha };
  };
  return { repo, git, branch };
}

test('the queue builds staging in order, each entry tested on top of the ones before', async () => {
  const { repo, git, branch } = repoWithBranches();
  const one = branch('bw/one', 'one.txt', '1\n');
  const two = branch('bw/two', 'two.txt', '2\n');
  const seen = [];
  const q = new MergeQueue({ repo, id: 't1', base: 'main', testCommand: 'x', tests: async (path) => { seen.push(execFileSync('ls', [path], { encoding: 'utf8' }).split('\n').filter(Boolean).sort().join(',')); return { passed: true }; } });
  q.enqueue('O1', [one]);
  q.enqueue('O2', [two]);
  assert.match(q.order(['m2']).error, /every queued entry/);
  q.order(['m2', 'm1']);
  const view = await q.build();
  assert.deepEqual(seen, ['a.txt,two.txt', 'a.txt,one.txt,two.txt'], 'm1 tested on top of m2');
  assert.ok(view.entries.every((e) => e.built.sha));
  assert.equal(git('rev-parse', 'main'), git('rev-parse', 'main~0'), 'main untouched by the build');
  assert.equal(git('rev-parse', '--verify', 'refs/heads/botwatch/staging-t1').length, 40);
});

test("attack: staging reaches the user's branch only on their click, at the reviewed commit", async () => {
  const { repo, git, branch } = repoWithBranches();
  const one = branch('bw/one', 'one.txt', '1\n');
  const q = new MergeQueue({ repo, id: 't2', base: 'main', tests: async () => ({ passed: true }) });
  q.enqueue('O1', [one]);
  const view = await q.build();
  const mainBefore = git('rev-parse', 'main');
  assert.match((await q.approve({ upTo: 'm1', sha: view.entries[0].built.sha })).error, /click Merge/);
  q.userApprovedMerge = true;
  assert.match((await q.approve({ upTo: 'm1', sha: 'deadbeef' })).error, /changed since you reviewed/);
  assert.equal(git('rev-parse', 'main'), mainBefore);
  const out = await q.approve({ upTo: 'm1', sha: view.entries[0].built.sha });
  assert.deepEqual(out.merged, ['m1']);
  assert.equal(git('rev-parse', 'main'), view.entries[0].built.sha);
});

test('a conflicting entry is left out of staging and says with what; approving it is refused', async () => {
  const { repo, branch } = repoWithBranches();
  const one = branch('bw/one', 'same.txt', 'one\n');
  const two = branch('bw/two', 'same.txt', 'two\n');
  const q = new MergeQueue({ repo, id: 't3', base: 'main', tests: async () => ({ passed: true }) });
  q.enqueue('O1', [one]);
  q.enqueue('O2', [two]);
  const view = await q.build();
  assert.ok(view.entries[0].built.sha);
  assert.deepEqual(view.entries[1].built.conflict.files, ['same.txt']);
  q.userApprovedMerge = true;
  assert.match((await q.approve({ upTo: 'm2', sha: 'x' })).error, /did not build/);
});

test('staging goes stale when the base moves, and must be rebuilt', async () => {
  const { repo, git, branch } = repoWithBranches();
  const one = branch('bw/one', 'one.txt', '1\n');
  const q = new MergeQueue({ repo, id: 't4', base: 'main', tests: async () => ({ passed: true }) });
  q.enqueue('O1', [one]);
  const view = await q.build();
  writeFileSync(join(repo, 'user.txt'), 'u\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the user moved on');
  q.userApprovedMerge = true;
  assert.match((await q.approve({ upTo: 'm1', sha: view.entries[0].built.sha })).error, /moved since staging was built/);
});

