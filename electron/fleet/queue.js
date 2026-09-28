// The merge queue. Finished orchestrators join it; the hypervisor orders it;
// pilld merges each entry into a staging branch on top of the ones before it
// and tests it there; the user approves one entry or all of them.
//
// The staging branch is BotWatch's (`botwatch/staging-<fleet>`), built by
// pilld outside any session's environment. Only the user's click merges
// staging into their branch, and only at the exact commit that was built and
// tested for the entry they approved.

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runTests } from '../orchestrator/testrun.js';

const execFile = promisify(execFileCb);
const git = (cwd, ...args) => execFile('git', ['-C', cwd, ...args], { timeout: 60_000 }).then(({ stdout }) => stdout.trim());

export class MergeQueue {
  constructor({ repo, id, base, testCommand = null, tests = runTests }) {
    Object.assign(this, { repo, id, base, testCommand, tests });
    this.branch = `botwatch/staging-${id}`;
    this.path = join(repo, '..', '.botwatch-worktrees', `staging-${id}`);
    this.entries = [];
    this.userApprovedMerge = false;
    this.built = null; // { baseSha, at }
    // The user's decisions on the queue: approvals, overrides with their
    // reasons, rejections. Nothing else writes here.
    this.log = [];
  }

  // An orchestrator's finished work: each worker branch at its snapshot.
  enqueue(owner, branches) {
    if (!branches.length) return { error: 'nothing to enqueue: no finished, snapshotted worker' };
    if (this.entries.some((e) => e.owner === owner && !e.merged)) return { error: `${owner} is already in the queue` };
    const entry = { id: `m${this.entries.length + 1}`, owner, branches, at: Date.now(), built: null, merged: false };
    this.entries.push(entry);
    this.built = null;
    return { queued: entry.id, position: this.pending().length };
  }

  pending() {
    return this.entries.filter((e) => !e.merged && !e.rejected);
  }

  // The user's rejection: the entry leaves the queue and is never merged.
  reject(id, reason) {
    const entry = this.pending().find((e) => e.id === id);
    if (!entry) return { error: `${id} is not in the queue` };
    if (!String(reason ?? '').trim()) return { error: 'a rejection needs a reason' };
    entry.rejected = { reason: String(reason), at: Date.now() };
    this.built = null;
    this.log.push({ at: Date.now(), kind: 'reject', ids: [id], owner: entry.owner, reason: String(reason) });
    return { rejected: id, owner: entry.owner };
  }

  // The hypervisor's order. Every pending entry, each once.
  order(ids) {
    const pending = this.pending();
    const want = new Set(ids);
    if (want.size !== ids.length || ids.length !== pending.length || !pending.every((e) => want.has(e.id))) {
      return { error: `order must name every queued entry once: ${pending.map((e) => e.id).join(', ')}` };
    }
    const byId = new Map(pending.map((e) => [e.id, e]));
    this.entries = [...this.entries.filter((e) => e.merged), ...ids.map((id) => byId.get(id))];
    this.built = null;
    return { order: ids };
  }

  // Staging from the base's current tip, each entry merged on top of the
  // ones before it and tested there. An entry that conflicts is left out and
  // says with what; the ones after it are built without it.
  async build() {
    const baseSha = await git(this.repo, 'rev-parse', `refs/heads/${this.base}`);
    if (!existsSync(this.path)) {
      mkdirSync(join(this.path, '..'), { recursive: true });
      await git(this.repo, 'worktree', 'add', '--detach', this.path, baseSha);
    }
    await git(this.path, 'checkout', '-q', '-B', this.branch, baseSha);
    for (const entry of this.pending()) {
      entry.built = null;
      const before = await git(this.path, 'rev-parse', 'HEAD');
      let conflict = null;
      for (const { branch, sha } of entry.branches) {
        try {
          await git(this.path, '-c', 'user.name=BotWatch', '-c', 'user.email=botwatch@localhost', 'merge', '--no-ff', '-m', `botwatch staging: ${entry.id} ${entry.owner} ${branch} @ ${sha.slice(0, 7)}`, sha);
        } catch {
          const files = await git(this.path, 'diff', '--name-only', '--diff-filter=U').catch(() => '');
          await git(this.path, 'merge', '--abort').catch(() => {});
          conflict = { branch, files: files.split('\n').filter(Boolean) };
          break;
        }
      }
      if (conflict) {
        await git(this.path, 'reset', '-q', '--hard', before);
        entry.built = { conflict, sha: null, test: null };
        continue;
      }
      const sha = await git(this.path, 'rev-parse', 'HEAD');
      const test = await this.tests(this.path, this.testCommand);
      entry.built = { sha, test, conflict: null };
    }
    this.built = { baseSha, at: Date.now() };
    return this.view();
  }

  view() {
    return {
      branch: this.branch,
      base: this.base,
      built: this.built,
      entries: this.pending().map((e) => ({ id: e.id, owner: e.owner, branches: e.branches, built: e.built })),
      log: this.log,
      merged: this.entries.filter((e) => e.merged).map((e) => ({ id: e.id, owner: e.owner, sha: e.mergedSha })),
    };
  }

  // The user's click: merge staging into their branch, up to and including
  // one entry (or all of them). Only what was built and tested, only if the
  // base hasn't moved since, and only with the click's approval set.
  //
  // Each entry's tests ran on staging: the base's current tip with every
  // entry before it merged in, then this one. Not the branch alone. An entry
  // whose tests failed (or timed out) is refused unless the user overrides
  // it, separately and with a reason, which goes in the log.
  async approve({ upTo, sha, override = null }) {
    if (!this.userApprovedMerge) return { error: 'merge needs the user to click Merge' };
    if (!this.built) return { error: 'the queue changed since staging was built; build and review it again' };
    const pending = this.pending();
    const index = pending.findIndex((e) => e.id === upTo);
    if (index === -1) return { error: `${upTo} is not in the queue` };
    const upto = pending.slice(0, index + 1);
    const bad = upto.find((e) => !e.built?.sha);
    if (bad) return { error: `${bad.id} did not build (${bad.built?.conflict ? `conflict in ${bad.built.conflict.files.join(', ') || bad.built.conflict.branch}` : 'not built'}); reorder or drop it first` };
    const failing = upto.filter((e) => e.built.test && e.built.test.passed === false);
    const overrideReason = String(override?.reason ?? '').trim();
    if (failing.length && !overrideReason) {
      return { error: `tests failed on staging for ${failing.map((e) => e.id).join(', ')}; merging it needs an override with a reason`, failing: failing.map((e) => e.id) };
    }
    const target = upto.at(-1).built.sha;
    if (sha !== target) return { error: 'staging changed since you reviewed it; review it again' };
    const head = await git(this.repo, 'rev-parse', `refs/heads/${this.base}`);
    if (head !== this.built.baseSha) return { error: `${this.base} moved since staging was built; build it again` };
    const current = await git(this.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (current !== this.base) return { error: `your checkout is on ${current}, not ${this.base}` };
    const midMerge = await git(this.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').then(() => true).catch(() => false);
    if (midMerge) return { error: 'your checkout is in the middle of a merge; finish or abort it first' };
    try {
      await git(this.repo, 'merge', '--ff-only', target);
    } catch (err) {
      return { error: `merge refused by git: ${String(err.stderr ?? err.message).trim().split('\n').pop()}` };
    }
    for (const e of upto) {
      e.merged = true;
      e.mergedSha = e.built.sha;
    }
    this.built = { baseSha: target, at: Date.now() };
    this.log.push({ at: Date.now(), kind: failing.length ? 'override' : 'approve', ids: upto.map((e) => e.id), sha: target, ...(failing.length ? { failing: failing.map((e) => e.id), reason: overrideReason } : {}) });
    return { merged: upto.map((e) => e.id), owners: upto.map((e) => e.owner), sha: target, ...(failing.length ? { overridden: failing.map((e) => e.id) } : {}) };
  }

  async close() {
    await git(this.repo, 'worktree', 'remove', '--force', this.path).catch(() => {});
  }
}
