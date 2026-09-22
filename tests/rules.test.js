// The spec's rules, one test per sentence of it. These are the parts a reader
// would otherwise have to trust me on: what gets truncated, which colour wins,
// what the estimate says when it does not know.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { abbrevTokens, formatDuration, formatElapsed, repoBasename, truncate } from '../src/format.js';
import { aggregateState, headerEta, headline, modelLabel, repoLabel, rowEta, useWidePill, usageTone } from '../src/model.js';

const at = (state, extra = {}) => ({ id: 'x', index: 1, repo: '/w/api', model: 'sonnet 5', state, summary: 's', etaSeconds: 10, startedAt: 0, ...extra });

test('truncate leaves copy that already fits untouched', () => {
  assert.equal(truncate('Refactoring auth, running tests', 34), 'Refactoring auth, running tests');
});

test('truncate backs up to the last space within eight characters of the cut', () => {
  assert.equal(truncate('Refactoring the auth middleware now', 34), 'Refactoring the auth middleware…');
});

test('truncate cuts mid-word when no space is near the cut', () => {
  assert.equal(truncate('a'.repeat(40), 10), `${'a'.repeat(9)}…`);
});

test('formatDuration marks every estimate with a tilde and picks one unit', () => {
  assert.equal(formatDuration(45), '~45s');
  assert.equal(formatDuration(244), '~4m');
  assert.equal(formatDuration(7200), '~2h');
});

test('formatDuration reports an unknown estimate as an em dash, not as zero', () => {
  assert.equal(formatDuration(null), '—');
});

test('abbrevTokens drops the trailing zero so the pill never pays for it', () => {
  assert.equal(abbrevTokens(40_000_000), '40M');
  assert.equal(abbrevTokens(15_600_000), '15.6M');
  assert.equal(abbrevTokens(840_000), '840k');
});

test('repoBasename shows the git root basename, capped', () => {
  assert.equal(repoBasename('/Users/me/work/api-gateway'), 'api-gateway');
  assert.equal(repoBasename('/Users/me/work/a-very-long-repo-name'), 'a-very-long-r…');
});

test('aggregate dot puts a stopped session ahead of a question', () => {
  assert.equal(aggregateState([at('waiting'), at('errored')]), 'errored');
});

test('aggregate dot puts a question ahead of work in progress', () => {
  assert.equal(aggregateState([at('working'), at('waiting')]), 'waiting');
});

test('aggregate dot is neutral with no sessions', () => {
  assert.equal(aggregateState([]), 'idle');
});

test('header estimate reads now whenever a session is blocked on a human', () => {
  assert.equal(headerEta([at('working', { startedAt: 1 }), at('waiting', { startedAt: 2 })], 1000), 'now');
});

test('header estimate follows the longest-running session, not the largest number', () => {
  const young = at('working', { startedAt: 500, etaSeconds: 3600 });
  const old = at('working', { startedAt: 100, etaSeconds: 60 });
  assert.equal(headerEta([young, old], 1000), '~1m');
});

test('row estimate reads now for a blocked session', () => {
  assert.equal(rowEta(at('waiting', { etaSeconds: 99 }), 1000), 'now');
});

test('a stopped session shows no time at all, since its clock is not running', () => {
  assert.equal(rowEta(at('errored', { etaSeconds: null, startedAt: 0 }), 600_000), '—');
  assert.equal(rowEta(at('stalled', { etaSeconds: null, startedAt: 0 }), 600_000), '—');
});

test('a reported estimate keeps the tilde and wins over elapsed time', () => {
  assert.equal(rowEta(at('working', { etaSeconds: 244, startedAt: 0 }), 600_000), '~4m');
});

test('with no estimate reported the slot falls back to elapsed, without a tilde', () => {
  assert.equal(rowEta(at('working', { etaSeconds: null, startedAt: 0 }), 600_000), '10m');
});

test('formatElapsed never wears a tilde, because it is measured not guessed', () => {
  assert.equal(formatElapsed(45), '45s');
  assert.equal(formatElapsed(600), '10m');
  assert.equal(formatElapsed(7300), '2h');
  assert.equal(formatElapsed(null), '—');
});

test('headline names the stopped session before the blocked one', () => {
  const text = headline([at('waiting', { index: 2 }), at('errored', { index: 4 })]);
  assert.match(text, /session 4 stopped/i);
});

test('headline does not call silence a failure', () => {
  assert.equal(headline([at('stalled', { index: 3 })]), 'Session 3 has gone quiet');
  assert.match(headline([at('errored', { index: 3 })]), /last command failed/);
});

test('a failed session is named ahead of a merely quiet one', () => {
  const text = headline([at('stalled', { index: 2 }), at('errored', { index: 5 })]);
  assert.match(text, /Session 5/);
});

test('headline defers to the sentence the adapter supplied', () => {
  assert.equal(headline([at('working')], 'Refactoring auth'), 'Refactoring auth');
});

test('repo chip collapses to a count when sessions span more than one repo', () => {
  assert.equal(repoLabel([at('working'), at('working', { repo: '/w/web' })]), '2 repos');
  assert.equal(repoLabel([at('working')]), 'api');
});

test('model collapses to mixed rather than picking a winner', () => {
  assert.equal(modelLabel([at('working'), at('working', { model: 'opus 5' })]), 'mixed');
});

test('wide pill needs a terminal wider than 900px', () => {
  assert.equal(useWidePill(901), true);
  assert.equal(useWidePill(900), false);
  assert.equal(useWidePill(undefined), false);
});

test('usage bar turns amber at 75 and red at 90', () => {
  assert.equal(usageTone(74.9), 'working');
  assert.equal(usageTone(75), 'waiting');
  assert.equal(usageTone(90), 'errored');
});
