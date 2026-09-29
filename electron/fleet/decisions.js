// The decision log: every answer any model gives, and every decision pilld
// carries out for one, with its level, the rule it cited and its full parent
// chain (H › O1 › w3).
//
// It records what was said. `rule` is the model's own words about which rule
// it used, or null when it gave none; nothing checks that the rule was
// followed, and the log never claims it was. Append-only JSON lines.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function chain(...ids) {
  return ids.filter(Boolean).join(' › ');
}

export function createDecisionLog(path) {
  const entries = [];
  if (path && existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
  }
  return {
    // kind: 'answer' | 'lease' | 'lock' | 'queue' | 'pause' | 'resume' | 'spawn' | 'human'
    record({ at = Date.now(), by, level, chain: parents, kind, question = null, text, rule = null }) {
      const entry = {
        at,
        by,
        level,
        chain: parents,
        kind,
        question,
        text: String(text ?? ''),
        // The model's own citation, verbatim. Recorded, not verified.
        rule: rule == null || String(rule).trim() === '' ? null : String(rule),
        verified: false,
      };
      entries.push(entry);
      if (path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      }
      return entry;
    },
    list(filter = {}) {
      return entries.filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v));
    },
  };
}
