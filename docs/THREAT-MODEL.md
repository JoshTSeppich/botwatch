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

**Before anything else: whatever a worker reads goes to Anthropic's API as part of its
conversation.** That's how every Claude Code session works, and no setting changes it. The rest of
this section is about the files a worker is kept from reading, and the network it can't reach.

**What BotWatch does**

- **Denies known secret locations** at two layers: Read-tool permission rules, and the Bash
  sandbox's `filesystem.denyRead`, which also applies to anything Bash runs. The locations are
  `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker/config.json`,
  `~/.gnupg`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.config/gh`,
  `~/Library/Keychains`, `~/Library/Cookies`, Safari, and the Chrome, Firefox, Brave, Edge and Arc
  profiles (`SECRET_PATHS` in `settings.js`).
- **This is a denylist, not confinement.** Everything not on the list is still readable: other
  dotfiles, other repos, your documents. A secret kept anywhere else is readable.
- **Network is Anthropic only** by default, with `strictAllowlist`, so an off-list host is refused
  outright rather than sent to an approval prompt. The package registries (npm, PyPI, crates.io)
  are opened only when setup's **Package installs** is on for that run.
- Workers can't reach BotWatch's sockets. The orchestrator's control socket is also 0600 and needs a
  per-run token.
- Tests run under BotWatch's own Seatbelt profile: no network past loopback, and writes only in the
  worktree and temp.
- The review flags new files that look like secrets, both by name (`.env`, keys, credentials) and
  by content (AWS keys, `sk-…`, GitHub tokens, private-key blocks). A flagged file doesn't merge
  unless you tick it by name.

**The environment.** A worker's environment is built from an **allowlist**, not "everything minus
a denylist": `PATH`, `HOME`, user, shell and temp, locale (`LANG`, `LC_*`), `TERM`, proxy and CA
settings, and Claude Code's own `ANTHROPIC_*` / `CLAUDE_CODE_*` / `CLAUDE_CONFIG_DIR`. Nothing else
the launching shell exported gets through. Claude's credentials, when they come from the
environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`), reach the CLI
so it can authenticate, and are hidden from its Bash by the sandbox's `credentials.envVars` deny.
Test runs get the allowlist without any credentials.

Measured: a real worker launched from a shell exporting `BOTWATCH_CANARY_SECRET` ran `env` and saw
64 variables, none of them the canary, and still authenticated and did its task. The sandbox deny,
shown with a harmless `ANTHROPIC_PROBE`: the CLI had it, and its Bash printed `probe=[unset]`.

**Measured**

Before the denylist:

| From a worker | Result |
| --- | --- |
| read a canary file in `$HOME` | **read** |
| list `~/.ssh` | **listed, including `id_ed25519`** |
| `https://registry.npmjs.org/` | **200** |
| `https://example.com`, `https://github.com` | blocked |
| connect to `control.sock` / `pilld.sock` | EPERM |

After it, with canaries in `~/.ssh` and `~/.aws` (removed afterwards):

| From a worker | Installs off | Installs on |
| --- | --- | --- |
| Read tool on `~/.ssh/…`, `~/.aws/…` | denied: "File is in a directory that is denied by your permission settings" | same |
| Bash `cat` on both, `ls ~/.ssh` | "Operation not permitted" | same |
| `https://registry.npmjs.org/` | blocked: "host is not on the allow list" | **200** |
| `npm install left-pad` | npm reports `E403 403 Forbidden` | not re-run |
| `npm test` (with `~/.npmrc` denied) | runs, passes | runs, passes |
| the session authenticates and works | yes | yes |

How a missing package plays out, from the pill with installs off: the worker's brief says installs
are off. It tried `npm install`, got npm's 403, and ended its turn with a question naming the
package. The question reached the pill. My answer ("use `padStart`, no dependency") came back to
it, and its snapshot has no `node_modules`. npm's own message ("403 Forbidden") is misleading. The
brief is what makes the failure clear, not npm.

**Open**

- **Reads outside the denylist.** A secret stored anywhere not on the list is readable, and then
  goes to Anthropic's API as part of the conversation.
- **With installs on, the registries are a way out.** A GET to `registry.npmjs.org/<text>` carries
  `<text>` to a third party. That is the trade the toggle makes, per run.
- Claude Code puts some variables into its own Bash that BotWatch doesn't control:
  `CLAUDE_CODE_MESSAGING_TOKEN` (the CLI's own channel) and `CLOUDSDK_PROXY_PASSWORD` (the
  sandbox's network proxy). They're the CLI's, not yours.

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

- **The changes themselves are in a terminal, not the pill.** Each review card's **Review in
  terminal** opens the diff of exactly the reviewed commit against where its branch left the base,
  with external diff drivers and textconv off, so nothing a worker committed can make git run a
  program. Reading it is still up to you.
- Failing tests are shown in red, but they don't block a merge. That's deliberate: a known-failing
  test can be the thing being fixed.
- Flags are heuristics. A secret in an innocent-looking file with an unrecognised format passes.
- Merged code runs later with your full permissions: `npm install` lifecycle scripts, `.envrc`, and
  anything else your tools execute from the repo.

## Also in scope

- **Remote debugging.** BotWatch never enables `--remote-debugging-port` or the Node inspector
  itself (a test checks the source for it). The packaged app's Electron fuses turn off `--inspect`
  and `NODE_OPTIONS`, and leave run-as-node on for the guard hook and MCP relay. Measured on the
  packaged build: fuses read back as set, the signature is valid, a normal launch opens no TCP
  listening port, and `--inspect=9229` opens nothing. There is no fuse for
  `--remote-debugging-port`: whoever launches the app can still pass it (that's how the demo was
  recorded). Anyone able to launch processes as you already has that access.

- **Forged hook events.** Any process running as you can write to `pilld.sock` and make a session
  look like it needs you. Workers can't (measured: EPERM). The cost of a forgery is a wrong colour.
- **The plugin runs `bw-hook` in every Claude Code session you start,** not only BotWatch's. It
  reads the hook payload, forwards it to the local socket, and exits within 50ms. It makes no
  network calls.
