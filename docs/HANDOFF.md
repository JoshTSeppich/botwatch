# Handoff

Written so the next session can pick this up cold. Everything here is either in the repo or was
measured against the real CLI; where something is unverified it says so.

## Where the build stands

| Piece | State |
| --- | --- |
| v1 pill (collapsed, expanded, usage, tray, drag, raise, permissions, packaging) | **shipped**, released `v0.1.0` |
| v1 data source | **hooks** — plugin → `bw-hook` → `~/.claude/botwatch/pilld.sock` → `electron/registry.js`. Transcripts supply model and tokens, and state only until a session's first hook |
| `bw-hook` (Rust, fire-and-forget) | **shipped in the app** as one universal binary inside `Contents/Resources/claude-plugin`; release workflow builds and verifies both slices |
| v3 orchestrator core (policy, budget, worktrees, worker, run, MCP, refguard, review, allowance) | **built and exercised against the real CLI** |
| v3 run hosting | **the run lives in pilld** (`orchestrator/pilot.js`); `mcp.js` only relays over `~/.claude/botwatch/control.sock` (0600, per-run token) |
| v3 UI | **setup panel (⌥⌘O), live tree, review panel with merge** — proven end to end on the packaged app |
| v2 (reply and approve) | **not started** |

99 tests. `npm test` must exit 0 before any commit — gate on the exit code, never on
grepping its output. I once pushed a red test because `npm test | grep` matched the failure line.

**No Co-Authored-By or AI attribution trailers in commits.** This overrides any tool default. Check
before pushing: `git log origin/main..main --format='%h %s%n%b' | grep -i co-authored-by` must
print nothing.

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
| **Wide pill is 544**, `Status Pill.dc.html` says **440** | Decided: the BotWatch README governs sizes. v1 and v3 now share 544; see `design-notes.md` |
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

- **The approval signal is an undocumented field.** If Claude Code stops writing `status` to
  `~/.claude/sessions/<pid>.json`, an approved slow command stays amber until `PostToolUse`.
- **Interrupting with Esc fires no hook.** A session interrupted mid-tool stays `working` until
  its next event, or goes `stuck` after ten minutes. Not measured whether `status` goes `idle`
  there; if it does, `registry.answered` is where to use it.

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

## Decisions (settled 2026-09-24)

None open. Don't reopen these without a new reason.

- **Wide pill is 544**, per the BotWatch README (see the deviations table).
- **The repo stays public**, take-home note and all.
- **The bundle id stays** `io.github.joshtseppich.botwatch`, so nobody has to grant permissions again.
- **Global git identity is left as is** (`josh@aetherx.io`). Only this repo uses the gmail, so
  snapshots in other repos carry the aetherx address, and that's accepted.

## What to do next, in order

1. **Close out the UI round** — every v3 state screenshotted on the inverted white pill; confirm the
   six-row tree matches the reference rather than raising the cap for convenience. *(Done as of this
   commit: accent and queued-segment tokens flipped, indent corrected to 14px, reference confirmed
   to show six rows with no overflow.)*
2. **Finish M1.** *(Done.)* Measured on 2.1.281, which the unit tests now pin:
   - `PermissionRequest` fires ~30ms after `PreToolUse`; the `permission_prompt` Notification
     trails it by **6.0s**. Both are registered; either turns the pill amber.
   - `AskUserQuestion` raises `PreToolUse`, then `PermissionRequest` **and** a `permission_prompt`
     Notification. The registry keeps it a question because `PreToolUse` named it first.
   - **No hook fires when a prompt is answered.** The next event is `PostToolUse` when the tool
     ends. The approval signal is the session file's `status` going `waiting → busy` (~70ms after
     the keypress), accepted only when written after the prompt went up (`registry.answered`).
   - `Stop` **does** carry `last_assistant_message`, despite the docs.
   - bw-hook's write timeout was per `write` call; a hung pilld plus a 200KB `Write` payload took
     115ms. It now has one 25ms delivery deadline. Worst case measured: 33.7ms native, 48.2ms for
     the x86_64 slice under Rosetta (no Intel Mac to measure natively). First exec of a newly
     installed binary costs ~270ms (native) / ~450ms (Rosetta) in the OS, before `main`.
3. **The loop end to end through the UI.** *(Done.)* Proven on the packaged app, driven through
   its real DOM over DevTools, against a scratch repo: ⌥⌘O → setup → Start → orchestrator spawns two
   haiku workers → each is snapshotted and its tests run → Review → Merge refused naming both
   flagged files → refused again with only `.env` ticked → both ticked → two `--no-ff` merges, each
   naming worker and SHA → `main`'s tests pass → Close run removes the ref hook. Found on the way:
   - **The guard hook never ran in a packaged app.** It was `node <path inside app.asar>`. The
     orchestrator scripts are now `asarUnpack`ed and run on the app's own binary
     (`ELECTRON_RUN_AS_NODE`), not a `node` that may not be on PATH (`orchestrator/runtime.js`).
   - **Workers defaulted to `default` mode**, which in headless `-p` denies every edit. They now
     get the mode chosen in setup unless the orchestrator asks for less.
   - `review()` filed new files as edits once snapshotted; merge had no way to name what was
     reviewed. Merge now takes `{ reviewed: [{branch, sha}], acknowledged: ['w1:.env'] }`, merges
     that SHA only, refuses a branch that moved, aborts a conflict, refuses a checkout mid-merge.
   - Tests run under a Seatbelt profile (`orchestrator/testrun.js`): no network past loopback,
     writes only in the worktree and temp. Worker-written tests never run with more than the worker.
   - The CLI itself creates an empty `.claude/.cc-writes/` in the **main checkout** when a worker
     starts. Not a tool call, so the deny rules don't see it; empty, so git never merges it.
   - The run tree must not rebuild under a click; it now rebuilds only when its content changes.
   - Not built: "Review in terminal", Pause/Resume (only Stop), the allowance line in setup.
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
