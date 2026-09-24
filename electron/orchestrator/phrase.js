// The plain-language half of a session: what a tool call, a permission prompt
// or a question reads as in a 52px row. Pure, so the hook path and the
// transcript fallback say the same thing about the same call.

// The spec wants a plain sentence. What is knowable is the tool in flight, so
// that is what this says rather than a prettier invention.
export function phrase(name, input = {}) {
  if (name === 'Bash') return `running ${program(input.command)}`;
  if (name === 'Read') return `reading ${basename(input.file_path)}`;
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') return `editing ${basename(input.file_path)}`;
  if (name === 'Grep' || name === 'Glob') return 'searching the codebase';
  if (name === 'Task' || name === 'Agent') return 'running a subagent';
  if (name === 'TodoWrite') return 'planning the next steps';
  if (name === 'mcp__botwatch__wait_for') return 'waiting for workers';
  if (name === 'mcp__botwatch__spawn_worker') return `starting a worker${input.task ? `: ${firstSentence(input.task)}` : ''}`;
  return `using ${toolLabel(name)}`;
}

// The same call, as the thing it is asking you to allow.
export function permissionLine(name, input = {}) {
  if (!name) return 'Needs your permission';
  if (name === 'Bash') return `Needs permission to run ${program(input.command)}`;
  if (name === 'Read') return `Needs permission to read ${basename(input.file_path)}`;
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    return `Needs permission to edit ${basename(input.file_path)}`;
  }
  if (name === 'WebFetch') return 'Needs permission to fetch a URL';
  return `Needs permission to use ${toolLabel(name)}`;
}

// AskUserQuestion carries its questions as data, so the row can quote the
// first one instead of saying "a question".
export function questionLine(input = {}) {
  const first = Array.isArray(input.questions) ? input.questions[0] : null;
  const text = first?.question ?? first?.header ?? '';
  return text ? `Asks: ${firstSentence(text)}` : 'Asks you a question';
}

// mcp__chrome-devtools__list_pages is a wire name, not something to read at 3m.
export function toolLabel(name) {
  const parts = String(name).split('__');
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

// Shell one-liners start with things that say nothing: cd, for, env prefixes.
// Walk past them to the command that is actually doing the work.
const SHELL_NOISE = new Set([
  'cd', 'export', 'set', 'sudo', 'time', ':',
  'for', 'while', 'until', 'if', 'do', 'then', 'done', 'fi', 'else', 'elif', 'esac', 'case',
]);

// Multiplexers carry their meaning in the subcommand: "npm test", "git log".
const CARRIES_SUBCOMMAND = ['npm', 'npx', 'git', 'uv', 'cargo', 'pnpm', 'yarn', 'node', 'python3', 'make'];

export function program(command) {
  const segments = String(command ?? '').split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const name = words[0];
    if (!name || SHELL_NOISE.has(name) || name.includes('=')) continue;
    const short = name.split('/').pop();
    const sub = words[1] && !words[1].startsWith('-') ? words[1] : null;
    return CARRIES_SUBCOMMAND.includes(short) && sub ? `${short} ${sub}` : short;
  }
  return 'a command';
}

export function basename(path) {
  return String(path ?? '').split('/').pop() || 'a file';
}

export function firstSentence(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const stop = clean.search(/[.!?](\s|$)/);
  return stop === -1 ? clean : clean.slice(0, stop + (clean[stop] === '?' ? 1 : 0));
}

// A model's reply as a row can hold it: its first sentence, without markdown.
export function plain(text) {
  const stripped = String(text ?? '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*(\d+\.|[-*])\s+/gm, '');
  // "Done!" and "Perfect!" open half of all replies and say nothing a ✓
  // doesn't; the sentence after them is the summary.
  const clean = stripped.replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const useful = sentences.find((sentence) => sentence.split(' ').length >= 3) ?? sentences[0] ?? '';
  return firstSentence(useful);
}
