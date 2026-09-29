// Path claims: which files each orchestrator's workers may change.
//
// A claim is a list of repo-relative globs (`packages/ui/theme/**`,
// `src/a.js`). Claims of different orchestrators in one repo may not
// overlap: on a conflict the claim waits until the hypervisor resolves it.
// Everything here is pure; the fleet holds the state and the enforcement.
//
// Enforcement, and how strong it is, is in fleet.js and enforce.mjs: another
// orchestrator's claim is a settings deny at spawn (prevented, tools and
// Bash alike), a worker's own claim is held by the enforcement hook for
// Write and Edit (prevented) and by a diff of its worktree for Bash
// (detected, then paused).

import { posix } from 'node:path';

// Globs as the permission rules and the user write them: `**` any depth,
// `*` within one segment, `?` one character. Anything else is literal.
export function normalize(glob) {
  let g = String(glob ?? '').trim().replace(/\\/g, '/');
  if (!g) return null;
  g = posix.normalize(g);
  if (g.startsWith('/') || g === '..' || g.startsWith('../')) return null; // repo-relative only
  if (g === '.') return '**';
  if (g.endsWith('/')) g = `${g}**`;
  return g;
}

export function toRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '/' && glob.slice(i) === '/**') {
      // `a/**` is a and everything under it.
      out += '(?:/.*)?';
      break;
    }
    if (c === '*' && glob[i + 1] === '*') {
      // `a/**` matches a itself and everything under it; `**/b` any depth.
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A bare directory claims what is under it.
  return new RegExp(`^${out}(?:/.*)?$`);
}

export function matches(path, globs) {
  const p = posix.normalize(String(path).replace(/\\/g, '/')).replace(/^\.\//, '');
  return globs.some((g) => toRegex(g).test(p));
}

// The literal part of a glob, up to its first wildcard, cut back to a whole
// segment. Two globs can only overlap if one's literal prefix is a prefix of
// the other's. Conservative: it may call an overlap where none exists (two
// wildcards that happen never to meet), never the other way round.
function stem(glob) {
  const i = glob.search(/[*?]/);
  const literal = i === -1 ? glob : glob.slice(0, i);
  if (i === -1) return literal;
  const cut = literal.lastIndexOf('/');
  return cut === -1 ? '' : literal.slice(0, cut + 1);
}

export function overlaps(a, b) {
  const sa = stem(a);
  const sb = stem(b);
  const exactA = !/[*?]/.test(a);
  const exactB = !/[*?]/.test(b);
  if (exactA && exactB) return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (exactA) return matches(a, [b]) || b.startsWith(`${a}/`);
  if (exactB) return matches(b, [a]) || a.startsWith(`${b}/`);
  return sa.startsWith(sb) || sb.startsWith(sa);
}

// Which already-granted claims a new one would collide with, by orchestrator.
// `granted` is [{ owner, repo, globs }].
export function conflictsWith(granted, { owner, repo, globs }) {
  const out = [];
  for (const claim of granted) {
    if (claim.owner === owner || claim.repo !== repo) continue;
    const pairs = [];
    for (const a of globs) for (const b of claim.globs) if (overlaps(a, b)) pairs.push([a, b]);
    if (pairs.length) out.push({ owner: claim.owner, pairs });
  }
  return out;
}

// Worktree-relative paths a worker changed, against its orchestrator's claim.
export function outside(paths, globs) {
  return paths.filter((p) => !matches(p, globs));
}
