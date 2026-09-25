import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRead, countMessages, decide, readBytes, transcriptFor } from '../electron/orchestrator/readcap.js';

const lines = (n, width = 20) => Array.from({ length: n }, () => 'x'.repeat(width)).join('\n');

test('a Read is sized as Claude Code reads it: 2,000 lines unless told, long lines cut, numbered', () => {
  assert.equal(readBytes(lines(10)), 10 * 27);
  assert.equal(readBytes(lines(5000)), 2000 * 27, 'the default is 2,000 lines');
  assert.equal(readBytes(lines(100), { offset: 91, limit: 50 }), 10 * 27, 'offset is 1-based, and the file ends');
  assert.equal(readBytes('y'.repeat(9000)), 2000 + 7, 'a long line is cut at 2,000 characters');
});

test('one Read over the size cap is refused, and says how to read it instead', () => {
  const d = decide(null, 3, 40_000);
  assert.equal(d.ok, false);
  assert.match(d.reason, /offset and limit/);
});

test('one message may make four Reads, and the fifth waits for the next message', () => {
  let ledger = null;
  for (let i = 0; i < 4; i += 1) {
    const d = decide(ledger, 7, 1_000);
    assert.equal(d.ok, true);
    ledger = d.ledger;
  }
  const fifth = decide(ledger, 7, 1_000);
  assert.equal(fifth.ok, false);
  assert.match(fifth.reason, /next message/);
  assert.equal(decide(ledger, 8, 1_000).ok, true, 'a new message starts a new step');
});

test('the Reads of one message are capped in total, not only one by one', () => {
  let ledger = decide(null, 1, 30_000).ledger;
  ledger = decide(ledger, 1, 30_000).ledger;
  const third = decide(ledger, 1, 30_000);
  assert.equal(third.ok, false);
  assert.match(third.reason, /one message may bring in 64,000/);
});

test("a subagent's calls are counted in its own transcript", () => {
  assert.equal(transcriptFor({ transcript_path: '/p/s1.jsonl' }), '/p/s1.jsonl');
  assert.equal(transcriptFor({ transcript_path: '/p/s1.jsonl', agent_id: 'a9' }), '/p/s1/subagents/agent-a9.jsonl');
});

test('messages are counted once each, and only new bytes are read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-readcap-'));
  const path = join(dir, 't.jsonl');
  const rec = (id) => `${JSON.stringify({ type: 'assistant', message: { id, content: [] } })}\n`;
  writeFileSync(path, rec('m1') + rec('m1') + rec('m2'));
  const first = countMessages(path);
  assert.equal(first.ids.length, 2);
  writeFileSync(path, rec('m1') + rec('m1') + rec('m2') + rec('m3') + '{"type":"assist');
  const second = countMessages(path, first);
  assert.equal(second.ids.length, 3, 'a half-written line waits');
});

test('the whole check, across calls: same message refused past the cap, next message allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-readcap-'));
  const transcript = join(dir, 's.jsonl');
  writeFileSync(transcript, '');
  const file = join(dir, 'a.js');
  writeFileSync(file, lines(1000, 40)); // ~47KB as read: over one Read's cap
  const small = join(dir, 'b.js');
  writeFileSync(small, lines(10));
  const event = (file_path, extra = {}) => ({ session_id: 's', transcript_path: transcript, cwd: dir, tool_input: { file_path, ...extra } });
  const ledgers = join(dir, 'steps');
  assert.equal(checkRead(event(file), { dir: ledgers }).ok, false);
  assert.equal(checkRead(event(file, { limit: 500 }), { dir: ledgers }).ok, true, 'read in parts, it passes');
  for (let i = 0; i < 3; i += 1) assert.equal(checkRead(event(small), { dir: ledgers }).ok, true);
  assert.equal(checkRead(event(small), { dir: ledgers }).ok, false, 'a fifth Read in the same message');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1' } })}\n`);
  assert.equal(checkRead(event(small), { dir: ledgers }).ok, true, 'the next message');
  assert.equal(checkRead(event(join(dir, 'missing.js')), { dir: ledgers }).ok, true, "a missing file is the tool's to refuse");
});

test('the guard refuses an oversized Read with exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-readcap-'));
  const file = join(dir, 'big.js');
  writeFileSync(file, lines(1500, 60));
  const guard = fileURLToPath(new URL('../electron/orchestrator/guard.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: 'Read', session_id: `t${Date.now()}`, cwd: dir, transcript_path: join(dir, 'none.jsonl'), tool_input: { file_path: file } }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /BotWatch caps what one step can read/);
});
