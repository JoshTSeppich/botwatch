#!/usr/bin/env node
// PreToolUse deny hook for orchestrator and worker sessions.
//
// The MCP merge gate refuses merge_worktrees, and that is worth nothing on its
// own: asked to get a branch onto main by any means, a model runs `git merge`
// through Bash and succeeds. This is the half that actually enforces it.
//
// The contract is the one the official plugin examples use: describe the
// refusal on stderr and exit 2, which blocks the call and tells Claude why.

import { isRepoWrite } from './policy.js';

let input = '';
process.stdin.on('data', (c) => {
  input += c;
});
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const command = event?.tool_input?.command;
  if (!command || !isRepoWrite(command)) process.exit(0);

  process.stderr.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      systemMessage:
        'BotWatch blocks git merge, push, rebase, reset and cherry-pick in orchestrator and worker sessions. ' +
        'Branches are merged by the user clicking Merge in the pill, never from a session.',
    }),
  );
  process.exit(2);
});
