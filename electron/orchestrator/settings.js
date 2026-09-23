// The settings blob handed to every session BotWatch spawns, via --settings.
//
// Two jobs. The PreToolUse guard makes the merge gate real rather than
// advisory. The deny rules keep a session's file writes out of the user's
// checkout — because refs are not the only thing worth protecting, and a
// worktree or a separate clone does nothing to stop `Write` with an absolute
// path pointed at your desktop.

import { fileURLToPath } from 'node:url';

export function guardSettings({ protect = [] } = {}) {
  const guard = fileURLToPath(new URL('./guard.mjs', import.meta.url));
  const deny = [];
  for (const path of protect) {
    // `//` is an absolute path in a permission rule.
    deny.push(`Write(/${path}/**)`, `Edit(/${path}/**)`, `NotebookEdit(/${path}/**)`);
  }
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(guard)}` }],
        },
      ],
    },
    ...(deny.length ? { permissions: { deny } } : {}),
  };
}
