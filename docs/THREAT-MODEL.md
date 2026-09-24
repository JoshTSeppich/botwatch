# Threat model

What BotWatch does about a worker going wrong, and what it doesn't. Everything here **reduces blast
radius**. None of it is a formal security boundary.

The threat is a worker session, a Claude Code process BotWatch starts, that does something you
didn't want. It might have been confused, prompt-injected by something it read, or simply wrong.
The orchestrator session is treated the same way. BotWatch (pilld) and your own terminal sessions
are trusted: they run as you, unsandboxed.

Every "measured" row below was run on 2026-09-24 on macOS 26.3.1 with Claude Code 2.1.281, against
the exact settings a worker gets (`guardSettings()`). Rows marked *earlier* were measured in a
previous session and recorded in `HANDOFF.md`; re-run them before relying on them.

## 1. The files in your checkout

**What BotWatch does**

- Each worker works in its own git worktree beside the repo, never inside it.
- Every spawned session is denied `Write`, `Edit` and `NotebookEdit` into your checkout by
  absolute path (permission deny rules).
- Bash runs in Claude Code's sandbox: `enabled`, `allowUnsandboxedCommands: false`,
  `failIfUnavailable: true`. Writes are confined to the session's own directory and temp.
- A worker's changes reach your checkout only through a merge, and only when you click it. See 4.

**What it relies on:** the Seatbelt sandbox on macOS, and Claude Code honouring its own deny rules.

**Measured**

| Attempt from a worker | Result |
| --- | --- |
| `echo pwned > <your checkout>/file` (at `bypassPermissions`), *earlier* | blocked |
| write to `$HOME` | blocked: "Operation not permitted" |
| write inside its own worktree | allowed |

**Open**

- The Claude Code CLI creates an empty `.claude/.cc-writes/` directory in the **main checkout**
  when a worker starts. The CLI does this itself, not through a tool call, so the deny rules don't
  apply. It's empty, so git never merges it.
- The sandbox is only as good as Seatbelt and Claude Code's use of it.

## 2. Refs and history

**What BotWatch does**

- A PreToolUse hook denies `git merge|push|rebase|reset|cherry-pick|branch -f|update-ref` by
  pattern. This catches the obvious spellings only.
- A `reference-transaction` hook refuses *any* move of a protected ref from a session carrying
  `BOTWATCH_GUARD`. It is installed for the run and removed when the run closes, including when you
  quit mid-run.
- The sandbox keeps workers out of the main repo's `.git`, so they can't delete that hook. It is
  also why workers don't commit: pilld snapshots each worktree to its branch.
- pilld does the merge itself, outside the guarded environment, and only:
  - on your click, with approval lasting for that one call
  - for a worker that has finished, been snapshotted and been tested
  - at exactly the commit you reviewed, refusing if the branch has moved since
  - as a `--no-ff` merge that names the worker and the commit
- A conflict is aborted and names the files. A checkout that's already mid-merge is refused, not
  aborted.
- Workers have no push target. The network allowlist leaves out GitHub, and the guarded
  environment removes push URLs and credential prompts.
- `merge_worktrees` never merges, even with approval set. The model can't reach the click.

**Measured**
- *earlier:* `rm .git/hooks/reference-transaction` from a worker: blocked.
- *earlier:* `g=merge; git $g` got past the pattern hook, and was aborted by the ref hook with the
  working tree left clean.
- *earlier:* `git update-ref`: refused.
- today: github.com from a worker: blocked.

**Open**

- `BOTWATCH_GUARD= git merge` gets past the ref hook's check, which is an environment marker and
  not a lock. The sandbox is what keeps that merge from reaching your `.git`.
- `git reset --hard` rewrites a working tree before any ref moves. It is confined to the worker's
  own worktree, but no hook undoes it.
- Separate clones per worker would harden refs further: `docs/tickets/separate-clones.md`, not built.

## 3. Secrets leaving the machine

**What BotWatch does**

- Worker network is an allowlist: Anthropic, npm, PyPI and crates.io. Nothing else.
- Workers can't reach BotWatch's sockets. The orchestrator's control socket is 0600 and needs a
  per-run token as well.
- Tests run under BotWatch's own Seatbelt profile: no network past loopback, and writes only in the
  worktree and temp.
- The review flags new files that look like secrets, both by name (`.env`, keys, credentials) and
  by content (AWS keys, `sk-…`, GitHub tokens, private-key blocks). A flagged file doesn't merge
  unless you tick it by name.

**Measured**

| From a worker | Result |
| --- | --- |
| read a canary file in `$HOME` | **read** |
| list `~/.ssh` | **listed, including `id_ed25519`** |
| `https://example.com`, `https://github.com` | blocked (sandbox: "deny network-outbound") |
| `https://registry.npmjs.org/` | **200** |
| connect to `control.sock` / `pilld.sock` | EPERM |

**Open, and the most important gap in this document**

- **Reads are not confined.** A worker can read anything you can: SSH keys, cloud credentials,
  browser profiles.
- **The allowlist is a way out.** A GET to `registry.npmjs.org/<anything>` puts `<anything>` in a
  third party's logs. The same goes for PyPI and crates.io.
- Anything a worker reads also becomes part of its conversation with Anthropic's API. That is true
  of every Claude Code session, and BotWatch doesn't change it.
- The fix is the sandbox's read restrictions for secret locations, and/or dropping the package
  registries from the allowlist for runs that don't need them. Neither is built.

## 4. Bad generated code

**What BotWatch does**

- Nothing merges without your click. The click covers exactly the commit you were shown.
- For each worker, the review shows the branch, the snapshot SHA and when it was taken, the test
  command with its result and time, and the files: edits and new files listed separately, with
  line counts.
- Build output, dependency folders and scratch files are flagged like secrets, and need
  acknowledging by name.
- Each merge is a separate `--no-ff` commit naming the worker and the SHA, so you can revert it
  on its own.

**What it relies on:** your test suite, and you reading what you merge.

**Open**

- **The pill shows which files changed, not the changes.** "Review in terminal", which would open
  the diff, is not built. Today you review the actual code in your own tools, from the branch name
  and SHA the panel gives you.
- Failing tests are shown in red, but they don't block a merge. That's deliberate: a known-failing
  test can be the thing being fixed.
- Flags are heuristics. A secret in an innocent-looking file with an unrecognised format passes.
- Merged code runs later with your full permissions: `npm install` lifecycle scripts, `.envrc`, and
  anything else your tools execute from the repo.

## Also in scope

- **Forged hook events.** Any process running as you can write to `pilld.sock` and make a session
  look like it needs you. Workers can't (measured: EPERM). The cost of a forgery is a wrong colour.
- **The plugin runs `bw-hook` in every Claude Code session you start,** not only BotWatch's. It
  reads the hook payload, forwards it to the local socket, and exits within 50ms. It makes no
  network calls.
