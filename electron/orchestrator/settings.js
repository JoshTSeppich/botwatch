// The settings blob handed to every session BotWatch spawns, via --settings.
//
// Two jobs. The PreToolUse guard makes the merge gate real rather than
// advisory. The deny rules keep a session's file writes out of the user's
// checkout — because refs are not the only thing worth protecting, and a
// worktree or a separate clone does nothing to stop `Write` with an absolute
// path pointed at your desktop.

import { scriptShellCommand } from './runtime.js';

// Domains a worker genuinely needs. Not github.com: a worker has no business
// reaching a remote, and leaving it out closes push at a second layer, below
// the missing pushurl and the absent credentials.
const WORKER_DOMAINS = [
  'api.anthropic.com',
  '*.anthropic.com',
  'registry.npmjs.org',
  '*.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
];

export function guardSettings({ protect = [], domains = WORKER_DOMAINS } = {}) {
  const guard = scriptShellCommand(new URL('./guard.mjs', import.meta.url));
  const deny = [];
  for (const path of protect) {
    // `//` is an absolute path in a permission rule.
    deny.push(`Write(/${path}/**)`, `Edit(/${path}/**)`, `NotebookEdit(/${path}/**)`);
  }
  // No filesystem block here on purpose. When the cwd is a linked worktree the
  // sandbox already allows writes to the main repo's shared .git so `git
  // commit` can update the index and refs, and it already denies `hooks/` and
  // `config` inside it. That native behaviour is what closes "a shell can
  // delete the reference-transaction hook"; adding my own allowWrite/denyWrite
  // on top of it broke committing instead of helping.

  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: guard }],
        },
      ],
    },
    sandbox: {
      enabled: true,
      // The escape hatch: without this, a command the sandbox cannot run falls
      // back to the permission flow, and under bypassPermissions that flow says
      // yes. Then none of the above means anything.
      allowUnsandboxedCommands: false,
      // If the sandbox cannot start, stop. Running unsandboxed with a warning
      // is the wrong default for a session nobody is watching.
      failIfUnavailable: true,
      // Sandboxed Bash runs without asking, in any permission mode but plan.
      // It is what lets an acceptEdits worker run its own tests headless,
      // where no one can approve a prompt — without handing it bypass. The
      // default is already true; stated here so a changed default can't
      // quietly break every worker. Measured on 2.1.281: `npm test`, git and
      // pipes run unprompted; `node -e "<code>"` still asks, flag or not.
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: domains },
    },
    ...(deny.length ? { permissions: { deny } } : {}),
  };
}
