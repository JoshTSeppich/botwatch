// The settings blob handed to every session BotWatch spawns, via --settings.
// It installs the PreToolUse guard, which is what makes the merge gate real
// rather than advisory.

import { fileURLToPath } from 'node:url';

export function guardSettings() {
  const guard = fileURLToPath(new URL('./guard.mjs', import.meta.url));
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(guard)}` }],
        },
      ],
    },
  };
}
