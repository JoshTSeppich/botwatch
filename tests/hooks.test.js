// M1: bw-hook → socket → pilld registry. The registry tests pin each
// transition; the socket tests run the real bw-hook binary when it has been
// built, and say they skipped when it has not.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listen } from '../electron/pilld.js';
import { createRegistry, notificationType, STALL_AFTER_MS } from '../electron/registry.js';
import { headline } from '../src/model.js';
import { modelName } from '../electron/sessions.live.js';

// The plugin's universal binary on a Mac (`npm run hook`), or a plain cargo
// build anywhere else — which is what CI on Linux has.
const BW_HOOK = ['../claude-plugin/botwatch/bin/bw-hook', '../bw-hook/target/release/bw-hook']
  .map((path) => fileURLToPath(new URL(path, import.meta.url)))
  .find((path) => existsSync(path));
const built = Boolean(BW_HOOK);

const ev = (hook_event_name, extra = {}) => ({ session_id: 's1', hook_event_name, ...extra });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

function feed(events) {
  const r = createRegistry();
  events.forEach((e, i) => r.apply(e, i));
  return r;
}

test('a prompt starts work and a tool call names it', () => {
  const r = feed([ev('SessionStart', { source: 'startup' }), ev('UserPromptSubmit'), ev('PreToolUse', bash('npm test'))]);
  assert.deepEqual(r.get('s1', 10), { state: 'working', needs: null, summary: 'running npm test', at: 2, model: null });
});

test('a permission Notification turns the session amber and says what it wants to run', () => {
  const r = feed([
    ev('UserPromptSubmit'),
    ev('PreToolUse', bash('rm -rf build')),
    ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
  ]);
  const s = r.get('s1', 10);
  assert.equal(s.state, 'waiting');
  assert.equal(s.needs, 'permission');
  assert.equal(s.summary, 'Needs permission to run rm');
});

test('approving the prompt returns the row to working', () => {
  const r = feed([
    ev('PreToolUse', bash('npm test')),
    ev('Notification', { notification_type: 'permission_prompt' }),
    ev('PostToolUse', bash('npm test')),
  ]);
  assert.equal(r.get('s1', 10).state, 'working');
  assert.equal(r.get('s1', 10).needs, null);
});

// Measured on 2.1.281: approval at 38.366, the session file's status went
// waiting → busy at 38.434, PostToolUse only when the command ended at 46.4.
test('an answered prompt returns to working as soon as the session file says busy', () => {
  const r = feed([ev('UserPromptSubmit'), ev('PreToolUse', bash('touch a && sleep 12')), ev('PermissionRequest', bash('touch a && sleep 12'))]);
  // The busy written before the prompt went up says nothing about the answer.
  assert.equal(r.answered('s1', 'busy', 1), false);
  assert.equal(r.answered('s1', 'waiting', 3), false);
  assert.equal(r.get('s1', 4).needs, 'permission');
  assert.equal(r.answered('s1', 'busy', 3), true);
  assert.deepEqual([r.get('s1', 4).state, r.get('s1', 4).needs, r.get('s1', 4).summary], ['working', null, 'running touch']);
});

test('the trailing permission Notification does not reset when the prompt went up', () => {
  const r = feed([ev('PreToolUse', bash('ls')), ev('PermissionRequest', bash('ls')), ev('Notification', { notification_type: 'permission_prompt' })]);
  // Answered at 1.5, between the prompt (1) and its six-second reminder (2).
  assert.equal(r.answered('s1', 'busy', 1.5), true);
});

test('an answered question returns to working too, and a finished turn is left alone', () => {
  const r = feed([ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} })]);
  assert.equal(r.answered('s1', 'busy', 1), true);
  r.apply(ev('Stop'), 2);
  assert.equal(r.answered('s1', 'busy', 3), false);
  assert.equal(r.get('s1', 4).needs, 'turn');
});

test('a model id with a date stamp keeps only its version', () => {
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'haiku 4.5');
  assert.equal(modelName('claude-opus-5-5'), 'opus 5.5');
});

test('PermissionRequest turns it amber before the Notification arrives', () => {
  const r = feed([ev('PreToolUse', bash('npm test')), ev('PermissionRequest', bash('npm test'))]);
  assert.equal(r.get('s1', 10).needs, 'permission');
});

test('a question is amber too, and says it is a question', () => {
  const input = { questions: [{ question: 'Which database should I use? Postgres or SQLite.' }] };
  const r = feed([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: input })]);
  const s = r.get('s1', 10);
  assert.equal(s.state, 'waiting');
  assert.equal(s.needs, 'question');
  assert.equal(s.summary, 'Asks: Which database should I use?');
});

test('a question stays a question when a permission-shaped Notification follows it', () => {
  const r = feed([
    ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Ship it?' }] } }),
    ev('Notification', { notification_type: 'permission_prompt' }),
  ]);
  assert.equal(r.get('s1', 10).needs, 'question');
});

test('Stop hands the turn back without calling it a question or a permission', () => {
  const r = feed([ev('UserPromptSubmit'), ev('Stop')]);
  assert.equal(r.get('s1', 10).state, 'waiting');
  assert.equal(r.get('s1', 10).needs, 'turn');
});

test('an idle reminder does not demote a pending permission prompt', () => {
  const r = feed([
    ev('PreToolUse', bash('ls')),
    ev('Notification', { notification_type: 'permission_prompt' }),
    ev('Notification', { notification_type: 'idle_prompt' }),
  ]);
  assert.equal(r.get('s1', 10).needs, 'permission');
});

test('an open turn with no events for ten minutes is stalled, or errored after a failure', () => {
  const r = feed([ev('PreToolUse', bash('sleep 9999'))]);
  assert.equal(r.get('s1', STALL_AFTER_MS).state, 'stalled');
  r.apply(ev('PostToolUseFailure', bash('false')), 1);
  assert.equal(r.get('s1', 1 + STALL_AFTER_MS).state, 'errored');
});

test('SessionEnd forgets the session; a killed one is pruned once unlisted', () => {
  const r = feed([ev('UserPromptSubmit'), ev('UserPromptSubmit', { session_id: 's2' })]);
  r.apply(ev('SessionEnd', { reason: 'prompt_input_exit' }), 2);
  assert.equal(r.get('s1', 3), null);
  r.prune(new Set(['s2']), 120_000);
  assert.notEqual(r.get('s2', 3), null);
  r.prune(new Set(), 120_000);
  assert.equal(r.get('s2', 3), null);
});

test('events without a session id are ignored', () => {
  const r = createRegistry();
  assert.equal(r.apply({ hook_event_name: 'Stop' }, 0), false);
  assert.equal(r.size(), 0);
});

test('notification type falls back to the message on an older CLI', () => {
  assert.equal(notificationType({ message: 'Claude needs your permission to use Bash' }), 'permission');
  assert.equal(notificationType({ message: 'Claude is waiting for your input' }), 'idle');
  assert.equal(notificationType({ notification_type: 'auth_success' }), 'other');
});

test('the headline says which kind of "needs you" it is, permission first', () => {
  const s = (index, needs) => ({ index, state: 'waiting', needs, startedAt: index, summary: '' });
  assert.equal(headline([s(1, 'question'), s(2, 'permission')]), 'Session 2 needs your permission');
  assert.equal(headline([s(1, 'turn'), s(2, 'question')]), 'Session 2 is asking you a question');
  assert.equal(headline([s(1, 'turn')]), 'Waiting for your answer in session 1');
});

function scratchSocket() {
  return join(mkdtempSync(join(tmpdir(), 'bw-')), 'pilld.sock');
}

function runHook(sock, payload) {
  const started = process.hrtime.bigint();
  const result = spawnSync(BW_HOOK, [], { input: payload, env: { ...process.env, BOTWATCH_SOCK: sock } });
  return { status: result.status, ms: Number(process.hrtime.bigint() - started) / 1e6, stdout: String(result.stdout) };
}

test('bw-hook delivers a hook event to pilld, and says nothing on stdout', { skip: !built && 'bw-hook not built' }, async () => {
  const sock = scratchSocket();
  const got = [];
  const server = await listen((event) => got.push(event), sock);
  try {
    const payload = JSON.stringify(ev('Notification', { notification_type: 'permission_prompt', message: 'a\nb' }));
    const run = await new Promise((resolve) => setImmediate(() => resolve(runHook(sock, payload))));
    assert.equal(run.status, 0);
    // Hook stdout is fed to the model on some events; bw-hook must add nothing.
    assert.equal(run.stdout, '');
    for (let i = 0; i < 50 && got.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(got.length, 1);
    assert.equal(got[0].notification_type, 'permission_prompt');
  } finally {
    server.close();
  }
});

test('with pilld down, bw-hook exits 0 inside 50ms', { skip: !built && 'bw-hook not built' }, () => {
  const run = runHook(scratchSocket(), JSON.stringify(ev('PreToolUse', bash('ls'))));
  assert.equal(run.status, 0);
  assert.ok(run.ms < 50, `took ${run.ms.toFixed(1)}ms`);
});

test('a second pilld refuses to take over a socket that is answering', async () => {
  const sock = scratchSocket();
  const server = await listen(() => {}, sock);
  try {
    await assert.rejects(listen(() => {}, sock), /another pilld/);
  } finally {
    server.close();
  }
});

test('pilld clears a stale socket file left by a crash', async () => {
  const sock = scratchSocket();
  const first = await listen(() => {}, sock);
  // Closing a server unlinks its socket; recreate the debris a crash leaves.
  await new Promise((r) => first.close(r));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(sock, '');
  const second = await listen(() => {}, sock);
  second.close();
});

test('a worker reply becomes one plain sentence, past any "Done!"', async () => {
  const { plain } = await import('../electron/orchestrator/phrase.js');
  assert.equal(plain("Done! I've added the `farewell` function to **src/greet.js**. Also a test."), "I've added the farewell function to src/greet.js");
  assert.equal(plain('Perfect! 1. **Created `scripts/build.js`** - copies src'), 'Created scripts/build.js - copies src');
});
