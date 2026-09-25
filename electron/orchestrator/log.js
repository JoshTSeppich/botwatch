// A worker's log, as the panel shows it: what it ran, what came back, what it
// said. Built from the same stream-json records the worker already reads, and
// trimmed hard — this is for following along, not for auditing, and the full
// transcript stays in ~/.claude/projects for that.

const RESULT_LINES = 4;
const RESULT_CHARS = 320;
const TEXT_CHARS = 600;
export const LOG_CAP = 400;

function clip(text, chars) {
  const s = String(text ?? '');
  return s.length > chars ? `${s.slice(0, chars - 1)}…` : s;
}

// The last few lines of a tool result: where the pass/fail line, the error or
// the answer usually is.
function tail(text) {
  const lines = String(text ?? '').trimEnd().split('\n');
  const kept = lines.slice(-RESULT_LINES);
  const skipped = lines.length - kept.length;
  return clip(`${skipped > 0 ? `… ${skipped} more lines\n` : ''}${kept.join('\n')}`, RESULT_CHARS);
}

function toolLine(part) {
  const input = part.input ?? {};
  const name = String(part.name ?? 'tool').replace(/^mcp__\w+__/, '');
  if (name === 'Bash') return `$ ${clip(input.command, 240)}`;
  if (input.file_path) return `${name} ${input.file_path}`;
  if (input.pattern) return `${name} ${input.pattern}`;
  return name;
}

function resultText(part) {
  const c = part.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n');
  return '';
}

// One stream-json record in, zero or more entries out: { kind, text, error? }.
export function logEntries(record) {
  if (!record || typeof record !== 'object') return [];
  if (record.type === 'system' && record.subtype === 'init') return [{ kind: 'system', text: 'session started' }];
  const content = Array.isArray(record.message?.content) ? record.message.content : [];
  if (record.type === 'assistant') {
    const out = [];
    for (const part of content) {
      if (part.type === 'text' && part.text?.trim()) out.push({ kind: 'text', text: clip(part.text.trim(), TEXT_CHARS) });
      if (part.type === 'tool_use') out.push({ kind: 'tool', text: toolLine(part) });
    }
    return out;
  }
  if (record.type === 'user') {
    return content
      .filter((part) => part.type === 'tool_result')
      .map((part) => ({ kind: 'result', text: tail(resultText(part)) || '(no output)', error: Boolean(part.is_error) }));
  }
  if (record.type === 'result') {
    return [{ kind: 'system', text: record.is_error ? 'turn ended with an error' : 'turn finished', error: Boolean(record.is_error) }];
  }
  return [];
}

// Appends with a running sequence number, so the panel can ask for "after n"
// and never miss or repeat an entry when old ones are dropped off the front.
export function appendLog(log, entries, at = Date.now()) {
  for (const entry of entries) {
    log.seq = (log.seq ?? 0) + 1;
    log.items.push({ seq: log.seq, at, ...entry });
  }
  if (log.items.length > LOG_CAP) log.items.splice(0, log.items.length - LOG_CAP);
  return log;
}

export function logSince(log, after = 0) {
  return log.items.filter((item) => item.seq > after);
}
