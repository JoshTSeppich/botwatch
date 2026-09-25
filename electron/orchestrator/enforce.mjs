#!/usr/bin/env node
// PreToolUse enforcement hook for the sessions a v4 fleet starts: may this
// session write this path? Asked of pilld, live, so a claim made after the
// session started still holds.
//
// Separate from bw-hook, which only reports and stays fail-open for the
// user's own sessions. This one refuses whenever it can't get a yes:
// pilld unreachable, no answer before its own deadline, anything unexpected.
// Its deadline is under Claude Code's hook timeout, because a hook that is
// timed out lets the call through (measured on 2.1.282). It is wired as
// `… || exit 2`, so a crash refuses too. The one gap: if Claude Code kills
// it at the timeout first (a stalled machine), the call goes through.
//
// Lives in electron/orchestrator so the packaged app unpacks it with the
// other scripts a session runs.

import { connect } from 'node:net';

const DEADLINE_MS = Number(process.env.BOTWATCH_ENFORCE_DEADLINE_MS) || 2000;

function refuse(reason) {
  process.stderr.write(`BotWatch refused this: ${reason}`);
  process.exit(2);
}

const timer = setTimeout(() => refuse('no answer from BotWatch in time'), DEADLINE_MS);

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    refuse('unreadable hook input');
  }
  const socket = process.env.BOTWATCH_ENFORCE_SOCK;
  const session = process.env.BOTWATCH_SESSION;
  if (!socket || !session) refuse('this session has no BotWatch identity');
  const input_ = event?.tool_input ?? {};
  const path = input_.file_path ?? input_.notebook_path ?? null;
  if (!path) refuse(`${event?.tool_name ?? 'this tool'} named no file`);

  const conn = connect(socket);
  let reply = '';
  conn.setEncoding('utf8');
  conn.on('error', () => refuse('BotWatch is unreachable'));
  conn.on('data', (chunk) => {
    reply += chunk;
    const cut = reply.indexOf('\n');
    if (cut === -1) return;
    let answer;
    try {
      answer = JSON.parse(reply.slice(0, cut));
    } catch {
      refuse('an unreadable answer from BotWatch');
    }
    clearTimeout(timer);
    conn.destroy();
    if (answer?.ok === true) process.exit(0);
    refuse(answer?.reason ?? 'not allowed');
  });
  conn.on('connect', () => conn.write(`${JSON.stringify({ session, tool: event?.tool_name, path, cwd: event?.cwd })}\n`));
});
