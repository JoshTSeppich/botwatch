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
| ~~Fullscreen on raise is off~~ — **now on by default**, as the spec says; `PILL_FULLSCREEN=0` turns it off | It was off because the pill vanished over a fullscreen Space. Measured 2026-09-24 on macOS 26.3.1: the real `fullscreenFront()` took a windowed Terminal.app window (80×24) and a windowed iTerm2 3.7.3 window (570×462) into native fullscreen, returned true, and the pill stayed on top (window server: on-screen, layer 1000; screenshots). The raise now targets the first `AXStandardWindow`, not `front window`: while an app is fullscreen macOS puts 33pt `AXUnknown` bar windows first. Not measured: Ghostty, WezTerm, kitty, Warp, older macOS |
| **Wide pill is 544**, `Status Pill.dc.html` says **440** | Decided: the BotWatch README governs sizes. v1 and v3 now share 544; see `design-notes.md` |
| **Model chips show real model ids** (`opus 5`), not the mockup's `opus 4.6` | The mockup's labels are a picture |
| **"% of what's left this week" carries source and age**, or is hidden | No live weekly limit exists. See "holes" |
| **Accent is `#4F56C9` on the white pill**, `#8B93FF` on the dark one | `#8B93FF` was drawn for a dark shell and is barely legible on white |

## Fullscreen: what works where

The pill drawing over native fullscreen was measured failing in the first session and working on
2026-09-24. The history does not say how the first test was run: the window setup and the claim
arrived together in the first overlay commit. So this is the table to trust, and the cells marked
unmeasured are the ones to test before changing anything.

| Overlay | Over | Result, macOS 26.3.1, Electron 44 |
| --- | --- | --- |
| packaged app | Terminal.app, native fullscreen, entering and leaving | **works** — screenshots |
| packaged app | iTerm2 3.7.3, native fullscreen, via the raise's own `fullscreenFront()` | **works** — screenshots |
| packaged app | Terminal.app, via `fullscreenFront()` | **works** — screenshots |
| dev build (`npx electron .`) | Terminal.app, native fullscreen | **works** — screenshot, only `Electron` running |
| either | Claude desktop app, native fullscreen | **unmeasured** — see below |

So "dev build vs packaged" is not the difference, at least over terminals. Suspects for the first
failure, in order: the Claude desktop app (the first test's host, and an Electron app itself), a
macOS update since, or the pill simply not re-docking because the tracker ignores a non-terminal
front window.

Why the Claude desktop cell is empty: its window was already fullscreen on its own Space, and
neither `activate` nor `open -a` switched to that Space from a script; Control-arrow Space
switching landed on other apps' Spaces. Testing it needs someone at the keyboard to swipe to it.

Two traps, both of which cost time here:

- **The window server's on-screen flag lies across fullscreen Spaces.** `CGWindowListCopyWindowInfo`
  with `optionOnScreenOnly` reported Claude's fullscreen window on screen while Terminal was
  showing. Only a screenshot settles whether the pill is visible.
- **`front window` of a fullscreen app is often a 33pt bar** (subrole `AXUnknown`) and reads
  `AXFullScreen = false`. Ask for the first `AXStandardWindow`.

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
- The sandbox reduces blast radius; it is not a formal security boundary. README uses this wording
  and should keep it.
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
   - **Merge is per branch** (`policy.canMergeBranch`): the worker is finished, snapshotted,
     tested, not already merged, and still at the reviewed SHA. Other workers running or queued
     don't block it. Proven live with three workers: w1 merged while w2 ran (w2's branch tip and
     worktree unchanged), w3 conflicted with w1 and was aborted leaving `main` clean, w2 merged
     separately once done — two `--no-ff` commits.
   - **acceptEdits workers do run commands**, through the sandbox's auto-allow
     (`sandbox.autoAllowBashIfSandboxed`, default true, independent of permission mode except
     plan). Now set explicitly in `guardSettings`. Proven live from the pill on setup's default:
     the worker ran `npm test` (`# pass 2`) with no approval and no bypass. An earlier note here
     said otherwise; it generalised from one refused command. What is refused, flag or not, is
     inline code: `node -e "<code>"` gets "This command requires approval".
   - **Claude Code refuses a standalone `sleep`** in a worker, even in the foreground.
4. *(Done: `docs/THREAT-MODEL.md`. The read gap it found is narrowed: secret locations denied at the Read tool and the Bash sandbox, registries off unless a run allows installs, all measured. Still a denylist, not confinement.)* **`docs/THREAT-MODEL.md`** separating: the checkout's files; refs and history; secret
   exfiltration; bad generated code. For each: what BotWatch does, what it relies on, what's open.
5. **Recovery.** *(Done: `tools/it-recovery.mjs`, all checks passing on 2026-09-24, plus
   `tests/recovery.test.js`.)* Every run writes `runs/<id>/run.json` (owner pid, repo, each
   session's pid and branch), and `recover()` runs at launch for runs whose BotWatch is gone:
   - **pilld killed mid-run**: the orchestrator and both workers were orphaned, and the ref hook
     was left in the repo. `recover()` stopped all three (checking each pid is still `claude`
     first), removed the hook, and kept the branches. It runs once per record.
   - **Orphaned worktree**: a worktree folder deleted by hand is pruned, but only if every
     prunable worktree is BotWatch's. `git worktree prune` has no per-path form, and the user's
     worktree on an unplugged drive must survive it.
   - **Worker crashed** (kill -9 mid-turn): now snapshotted at exit, so its partial work is
     reviewable. It can't merge, because it didn't finish.
   - **Stale session file**: the pid is alive but belongs to another process. It's ignored now,
     by comparing the file's `procStart` with `ps -o lstart` in UTC.
   - **Merge interrupted**: a leftover `index.lock` is refused with a message naming the file.
     MERGE_HEAD was already refused.
   Found on the way: `refguard.uninstall()` deleted any `reference-transaction` hook, the user's
   included. It now removes only BotWatch's.
   Not covered: an owner pid reused by another live process makes `recover()` skip that run until
   the pid is free. The record doesn't store the owner's start time yet.

**Question passed up: done.** A worker that needs a decision ends its turn with `QUESTION: …`
and becomes `asking` (accent `?`, not snapshotted, not mergeable); `wait_for` returns the moment
any worker asks; the orchestrator either answers or calls `ask_human` with the question, its reason
and a suggestion, which blocks until the user replies from the pill's question card; the answer
goes back with `message_worker`. Acceptance demo, packaged app, acceptEdits, three haiku workers:
w2 asked formal-or-casual, the card showed reason and suggestion (casual), the answer "formal" came
back as `Good day, ${name}.` five seconds later; w3's `.env` and `dist/` were flagged and Merge
refused naming both; acknowledged, merged; w1 merged separately; w2 then conflicted with w1 and the
app showed "conflicts with what is already on your branch in src/greet.js, test/greet.test.js.
Nothing was changed."

**Worker log panel: done.** Clicking a worker opens a 300px log beside the card, polled once a
second by sequence number (`electron/orchestrator/log.js`, capped at 400 entries). **Take over**
takes two clicks. It stops the headless worker and waits for it to exit, marks the worktree trusted
in `~/.claude.json` (one key, re-read, temp file plus rename, and never written if the file won't
parse), then opens `claude --resume <session>` in Terminal in the worktree. After that,
`message_worker` and `stop_worker` refuse it and the merge gate refuses it. Proven live: the
resumed session opened on the worker's conversation. Found on the way:
- Without the trust key, the resumed session stops at "Is this a project you trust?" for a
  worktree nobody opened interactively. The user chose pre-trust on Take over.
- The resumed session runs under the user's own settings (here, bypass), not the worker's
  sandbox. That's what taking over means, and the README says so.
- Headless workers get compound commands with command substitution refused: `for i in $(seq 1
  200); do npm test; done` gave "The following parts require approval: seq 1 200, npm test". The
  sandbox auto-allow covers plain commands and pipes, not that.
- The orchestrator's `O` is in the sans font now.

**Motion: done** (`src/motion.js`, `tests/motion.test.js`). Each part was checked live in the app:
- **The wheel.** It turns the content right of the status mark, in the v1 pill and in the
  orchestrator line, whose header now outlives the tree's rebuilds so it can turn. It turns only
  on a change of meaning, and at most every 1.6s (unit tests, with a fake clock). Live, frame by
  frame: the new line starts at `translateY(-18px) scaleY(0)` and the old one drops and fades.
  Reduced motion is a 120ms crossfade with no transforms (tested). Why "on change" and not the
  spec sheet's continuous wheel: design-notes.
- **Finished.** "w1 finished: <task>" with a ✓ for 2.6s, and a 1.6s row flash. Live: the flash at
  18.77s, the line at 18.79s, and back to "Ready to review" at 21.77s.
- **Escalation (F6).** Only for a real "needs you" (a permission or a question), not a finished
  turn. On the pill and on the question card. Live, with a real permission prompt left waiting:
  ~5s stage 1 (2s pulse); ~35s stage 2 (1.2s pulse, amber border at 45%); 2m15s stage 3 (amber
  border and rim). A `pointerenter` reset it to stage 1. That was dispatched in the page:
  synthetic mouse moves didn't reach the overlay then, likely because it wasn't on the front Space.
- **Found:** Chromium throttled the overlay's timers while it counted as hidden, which stretches
  the one-second tick and could swallow the 2.6s line. The window now sets
  `backgroundThrottling: false`.

**Review in terminal: done.** Each review card opens `git diff <fork point> <reviewed SHA>` in
Terminal (`Run.diffCommand`). It works only for this run's branches, and only for a commit on
that branch. It uses `--no-ext-diff --no-textconv`, and every argument is shell-quoted. Proven
live: after w1 merged, w2's terminal diff showed only w2's two files. Found and fixed on the way:
`review()` diffed against the base's **tip**, so after one worker merged, every other worker's
review showed that merge reversed. It now diffs from the fork point (`forkPoint`). The
regression test fails on the old code. Workers are also told to keep shell commands plain
(loops and `$(…)` are refused headless).

**Demo: done.** `docs/demo.gif` and `docs/demo.mp4`: 60s, recorded with `tools/record-pill.mjs`,
which records the pill's own page over the DevTools port and never the screen behind it, so nothing
else is in it. Worker waits play 8× faster (the driver sets a mode file); everything else is real
time. To re-record: run the packaged app with `--remote-debugging-port=9222`, start the
recorder, drive the run, then SIGTERM the recorder to encode. Found while recording: the setup
panel's free-text repo path put the home directory on screen. It now offers repo chips (folder
names, with the full path on hover) and a native **Choose folder…**, as the spec drew it. One take
was spoiled by a real click on a worker row, which opened its log panel.

## How the code is arranged

`electron/orchestrator/` is the v3 engine and is pure Node — testable without Electron.
`policy.js` holds every limit the model must not talk past. `run.js` is the only stateful piece.
`src/` is the renderer: `format.js` (pure text rules), `model.js` (precedence), `render.js` (v1),
`orchestrator-view.js` (v3), `interact.js` (time-based rules).

Anything that must be right is a pure function with a test: `stripPlan`, `badgeTone`,
`clampPermission`, `isRepoWrite`, `suspectByName`, `weeklyAllowance`, `snapshotMessage`.

Integration scripts in `tools/` spend real tokens and need a logged-in CLI, so they are **not** in
`npm test`: `smoke-worker`, `it-spawn`, `it-waitfor`, `it-message`, `it-diff`, `it-mcp`, `it-reap`,
`it-recovery` (with its host, `it-recovery-host`).
