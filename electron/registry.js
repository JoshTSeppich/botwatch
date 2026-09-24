// pilld's registry: what every session is doing, as its hooks report it.
// bw-hook forwards each hook's JSON unchanged, one line per event, and this
// folds them into one entry per session. Pure — no socket, no clock of its
// own — so every transition has a test.
//
// Hooks can say what the transcript could not: that a session is sitting on a
// permission prompt rather than running a long command, and whether it is
// asking you a question or asking you to allow something. They cannot say
// when a session died without saying goodbye; liveness stays the pid's job.

import { firstSentence, permissionLine, phrase, questionLine } from './phrase.js';

// Nothing has happened for this long while a turn is still open: the session is
// probably stuck. Ten minutes, because a long build or test run is silent for
// minutes at a time and a false "stuck" is worse than a late one.
export const STALL_AFTER_MS = 600_000;

// A hook can arrive before the session's own file is written, so an entry is
// not dropped the moment it goes unlisted.
const FORGET_AFTER_MS = 60_000;

export function createRegistry() {
  const entries = new Map();

  function entryFor(id, at) {
    let entry = entries.get(id);
    if (!entry) {
      entry = { state: 'idle', needs: null, summary: 'idle', at, askedAt: 0, failed: false, tool: null, model: null };
      entries.set(id, entry);
    }
    entry.at = at;
    return entry;
  }

  function working(entry, summary) {
    entry.state = 'working';
    entry.needs = null;
    if (summary) entry.summary = summary;
  }

  function waiting(entry, needs, summary) {
    // When the prompt went up. A reminder about the same prompt — the
    // Notification that trails PermissionRequest by six seconds — is not a
    // new prompt, and must not move it.
    if (entry.state !== 'waiting' || entry.needs !== needs) entry.askedAt = entry.at;
    entry.state = 'waiting';
    entry.needs = needs;
    entry.summary = summary;
  }

  // Returns true when the event changed anything, which is all the socket
  // server needs to know.
  function apply(event, at) {
    const id = event?.session_id;
    const kind = event?.hook_event_name;
    if (typeof id !== 'string' || typeof kind !== 'string') return false;

    if (kind === 'SessionEnd') return entries.delete(id);
    const entry = entryFor(id, at);
    if (typeof event.model === 'string') entry.model = event.model;

    switch (kind) {
      case 'SessionStart':
        // A compaction or a resume is the same session carrying on.
        if (event.source === 'startup' || event.source === 'clear') {
          Object.assign(entry, { state: 'idle', needs: null, summary: 'idle', failed: false, tool: null });
        }
        break;
      case 'UserPromptSubmit':
        entry.failed = false;
        working(entry, 'working');
        break;
      case 'PreToolUse':
        entry.tool = { name: event.tool_name, input: event.tool_input ?? {} };
        // A question is a tool call whose whole point is to stop for you, and
        // it may never raise a Notification of its own.
        if (event.tool_name === 'AskUserQuestion') waiting(entry, 'question', questionLine(event.tool_input));
        else working(entry, phrase(event.tool_name, event.tool_input ?? {}));
        break;
      case 'PermissionRequest':
        entry.tool = { name: event.tool_name, input: event.tool_input ?? {} };
        waitForPermission(entry);
        break;
      case 'Notification':
        notify(entry, event);
        break;
      case 'PostToolUse':
        entry.failed = false;
        working(entry, entry.tool && entry.tool.name !== 'AskUserQuestion' ? phrase(entry.tool.name, entry.tool.input) : 'working');
        break;
      case 'PostToolUseFailure':
        entry.failed = true;
        working(entry, entry.tool ? phrase(entry.tool.name, entry.tool.input) : 'working');
        break;
      case 'Stop': {
        entry.tool = null;
        const said = typeof event.last_assistant_message === 'string' ? firstSentence(event.last_assistant_message) : '';
        waiting(entry, 'turn', said || 'waiting for you');
        break;
      }
      default:
        // SubagentStop, PreCompact and anything newer: proof of life, nothing more.
        break;
    }
    return true;
  }

  function waitForPermission(entry) {
    // A question can raise a permission-shaped Notification too; the question
    // is the more specific thing to show.
    if (entry.needs === 'question') return;
    waiting(entry, 'permission', permissionLine(entry.tool?.name, entry.tool?.input));
  }

  function notify(entry, event) {
    const type = notificationType(event);
    if (type === 'permission') waitForPermission(entry);
    else if (type === 'question') {
      if (entry.needs !== 'question') waiting(entry, 'question', 'Asks you a question');
    } else if (type === 'idle' && entry.state !== 'waiting') waiting(entry, 'turn', 'waiting for you');
  }

  // No hook fires when you answer a prompt: the next event is PostToolUse, when
  // the tool finishes, which for a twelve-second command is twelve seconds of
  // amber after you said yes. Claude Code's own session file flips to "busy"
  // within ~70ms of the answer, so a "busy" written after the prompt went up
  // means it was answered. This only ever clears "needs you"; it never sets it.
  function answered(id, status, statusAt) {
    const entry = entries.get(id);
    if (!entry || entry.state !== 'waiting') return false;
    if (entry.needs !== 'permission' && entry.needs !== 'question') return false;
    if (status !== 'busy' || !(statusAt > entry.askedAt)) return false;
    working(entry, entry.tool && entry.needs === 'permission' ? phrase(entry.tool.name, entry.tool.input) : 'working');
    return true;
  }

  // State as of `now`: an open turn that has gone silent is stalled, or
  // errored if the last thing that happened was a failure.
  function get(id, now) {
    const entry = entries.get(id);
    if (!entry) return null;
    let state = entry.state;
    if (state === 'working' && now - entry.at >= STALL_AFTER_MS) state = entry.failed ? 'errored' : 'stalled';
    return { state, needs: entry.needs, summary: entry.summary, at: entry.at, model: entry.model };
  }

  // Sessions that are gone without a SessionEnd — killed, crashed — are
  // dropped once the listing has not mentioned them for a while.
  function prune(liveIds, now) {
    for (const [id, entry] of entries) {
      if (!liveIds.has(id) && now - entry.at > FORGET_AFTER_MS) entries.delete(id);
    }
  }

  return { apply, answered, get, prune, size: () => entries.size };
}

// notification_type is the reliable field; the message is the fallback for a
// CLI that does not send one.
export function notificationType(event) {
  const type = String(event?.notification_type ?? '');
  if (type === 'permission_prompt') return 'permission';
  if (type === 'elicitation_dialog') return 'question';
  if (type === 'idle_prompt') return 'idle';
  if (type) return 'other';
  const message = String(event?.message ?? '');
  if (/permission/i.test(message)) return 'permission';
  if (/waiting for your input/i.test(message)) return 'idle';
  return 'other';
}
