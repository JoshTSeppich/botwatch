# Handoff

Written so the next session can pick this up cold. Everything here is either in the repo or was
measured against the real CLI; where something is unverified it says so.

## Where the build stands

| Piece | State |
| --- | --- |
| v1 pill (collapsed, expanded, usage, tray, drag, raise, permissions, packaging) | **shipped**, released `v0.1.0` |
| v1 data source | reads `~/.claude` transcripts. **The hook pipeline is not wired** |
| `bw-hook` (Rust, 50ms fire-and-forget) | **builds, unused** — nothing listens on the socket |
| v3 orchestrator core (policy, budget, worktrees, worker, run, MCP, refguard, review, allowance) | **built and exercised against the real CLI** |
| v3 UI | **collapsed line + expanded tree only** |
| v2 (reply and approve) | **not started** |

78 tests, 35 commits. `npm test` must exit 0 before any commit — gate on the exit code, never on
grepping its output. I once pushed a red test because `npm test | grep` matched the failure line.

## The reference files, and which one governs what

All three are in `~/Downloads/design_handoff_botwatch/`. None is in this repo.

| File | Governs | How to use it |
| --- | --- | --- |
| `design/BotWatch Roadmap.dc.html` | **layout and geometry** | Serve the folder and open it. Renders statically, ~5100px. The v3 band starts at scroll 3413. Captions carry numbers the screenshots don't, e.g. "Workers are indented 14px" |
| `design/BotWatch v3 Demo.html` | **motion and copy** | Serve it, then **hover the pill and press `O`**, then `⌘↵`. The TRY buttons (`set up · plan · run …`) are hints, not triggers — clicking them does nothing |
| `README.md` (the handoff) | **tokens, sizes, rules** | Colours, type, radii, heights, motion timings |
| `design/Status Pill.dc.html` | v1 spec sheet | What v1 was built from |

Two traps, both of which cost time:

- `document.getAnimations()` returns **0** on the demo. It animates via CSS and transforms, not the
  Web Animations API. That is not evidence the demo is broken.
- Headless vs headed makes no difference. The demo needs the hover-then-key interaction.

Serve with `python3 -m http.server`, drive with the Chrome DevTools MCP against
`--remote-debugging-port=9222`.

## Deviations from the handoff, and why

| Deviation | Why |
| --- | --- |
| **Surface is inverted** — near-white pill on a dark OS, near-black on a light one. Spec draws a dark translucent pill | Joshua's call. The spec's pill was built to blend into window chrome; a monitor you have to look for isn't doing its job |
| **Workers don't commit.** pilld snapshots each worktree to its branch when a turn ends | The Bash sandbox keeps workers out of the main repo's `.git`, which is what denies them `.git/hooks`. Four runs against the CLI failed identically on `index.lock`; the documented linked-worktree allowance did not apply on **2.1.280**. See `design-notes.md` |
| **No merge token.** pilld performs the merge itself, outside the guard env | The token existed only because the agent did the merging. Removing it removed a forgeable file and a wildcard window |
| **Fullscreen on raise is off** unless `PILL_FULLSCREEN=1` | The overlay can't draw over a macOS fullscreen Space, so obeying the spec made the pill vanish on the click that used it |
| **Wide pill is 440px**, handoff says **544** | v1 was built from `Status Pill.dc.html`, which says 440. The BotWatch README says 544. **Unreconciled — decide before v1 is called done.** v3's own line uses 544 (`.is-xwide`) because it carries repo, sentence, strip, model and time |
| **Model chips show real model ids** (`opus 5`), not the mockup's `opus 4.6` | The mockup's labels are a picture |
| **"% of what's left this week" carries source and age**, or is hidden | No live weekly limit exists. See "holes" |
| **Accent is `#4F56C9` on the white pill**, `#8B93FF` on the dark one | `#8B93FF` was drawn for a dark shell and is barely legible on white |

## Security model, in one paragraph

Every session BotWatch spawns gets, via `--settings`: Claude Code's Bash **sandbox** (`enabled`,
`allowUnsandboxedCommands: false`, `failIfUnavailable: true`, network allowlist that omits GitHub),
**permission deny rules** for `Write`/`Edit`/`NotebookEdit` into the user's checkout, and a
**PreToolUse hook** denying `git merge|push|rebase|reset|cherry-pick|branch -f|update-ref` by
pattern. The repo also gets a **`reference-transaction` hook** that refuses any move of a protected
ref from a session carrying `BOTWATCH_GUARD`, with no exception — BotWatch merges from outside that
environment on the user's click. The orchestrator runs in its own directory, never the checkout.

Measured at `bypassPermissions`: `echo pwned > <checkout>/f` blocked, `rm .git/hooks/reference-transaction`
blocked, `g=merge; git $g` aborted mid-transaction with the working tree left clean, `git update-ref`
refused, and the same ref merges cleanly when pilld does it.

## The holes

- A session with a shell can **delete the ref hook** or run `BOTWATCH_GUARD= git merge`. The sandbox
  narrows this (it can't reach the checkout's `.git`) but the env check is a marker, not a lock.
- `git reset --hard` overwrites a working tree **before** touching any ref — confined to the
  worker's own worktree, but no hook undoes it.
- **No live weekly plan limit exists.** `rate_limit_event` appears only in `stream-json` output from
  a `claude -p` run, i.e. only when a worker runs. Zero genuine records across 33 transcripts;
  nothing on disk. A refresh probe costs ~24k tokens, so don't poll for it.
- The sandbox is an OS boundary, not a proof.
- **Separate clones** would improve ref and history safety and do nothing for file writes —
  `docs/tickets/separate-clones.md`, not built.

## Open decisions

1. **440 vs 544** for the v1 wide pill (above).
2. **Publishing.** The repo is public and the README says it was built as a take-home; Joshua had
   not submitted at the time of writing. Flipping it private until after submission was offered and
   not taken up.
3. **Global git identity** is still `josh@aetherx.io`; only this repo is set to the gmail. Snapshots
   in other repos will carry the aetherx address.
4. **Bundle id** `io.github.joshtseppich.botwatch` — changing it costs a permission re-grant.

## What to do next, in order

1. **Close out the UI round** — every v3 state screenshotted on the inverted white pill; confirm the
   six-row tree matches the reference rather than raising the cap for convenience. *(Done as of this
   commit: accent and queued-segment tokens flipped, indent corrected to 14px, reference confirmed
   to show six rows with no overflow.)*
2. **Finish M1**: `bw-hook` → unix socket → pilld registry, with the **Notification hook** driving
   "needs you". Until then the pill infers state from transcript shape and cannot tell a question
   from a permission prompt. Demonstrate a real permission prompt turning the pill amber, and fix
   the README's "What it can't tell you" if it goes stale.
3. **The loop end to end through the UI**: setup panel (`⌥⌘O`), merge review panel (edits and new
   files separately, flags, an acknowledge step, per-worker provenance: id, branch, snapshot SHA,
   test command and result, timestamp). Prove it on a scratch repo with a worker that leaves a
   `.env` and build output behind.
4. **`docs/THREAT-MODEL.md`** separating: the checkout's files; refs and history; secret
   exfiltration; bad generated code. For each: what BotWatch does, what it relies on, what's open.
5. **Recovery**, as integration scripts in `tools/`: app killed mid-run, worker crashed, stale
   session file, orphaned worktree and branch, merge interrupted halfway.

Then question-passed-up, the worker log panel, and motion — in that order, last.

## How the code is arranged

`electron/orchestrator/` is the v3 engine and is pure Node — testable without Electron.
`policy.js` holds every limit the model must not talk past. `run.js` is the only stateful piece.
`src/` is the renderer: `format.js` (pure text rules), `model.js` (precedence), `render.js` (v1),
`orchestrator-view.js` (v3), `interact.js` (time-based rules).

Anything that must be right is a pure function with a test: `stripPlan`, `badgeTone`,
`clampPermission`, `isRepoWrite`, `suspectByName`, `weeklyAllowance`, `snapshotMessage`.

Integration scripts in `tools/` spend real tokens and need a logged-in CLI, so they are **not** in
`npm test`: `smoke-worker`, `it-spawn`, `it-waitfor`, `it-message`, `it-diff`, `it-mcp`, `it-reap`.
