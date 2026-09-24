# Design notes

Built from a [design spec](https://claude.ai/design/p/3b3fdf6a-c283-42ad-b6ac-123034dc88e5?file=Status+Pill.dc.html)
that described the pill down to the pixel. Where I departed from it, it's here with the reason.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Surface | The pill opposes the OS theme | Near-white on a dark terminal, near-black on a light one. The spec drew a dark translucent pill on a dark terminal, built to blend into the window chrome. A monitor you have to look for isn't doing its job. This is the biggest deliberate break. |
| Rendering | Build the DOM once, patch it every tick | A 1Hz rebuild drops hover and restarts the dot's pulse. The spec allows two animations and this isn't one of them. |
| Truncation | Character cap first, CSS ellipsis always on | The cap is a ceiling for Latin copy. Measured width is what actually stops the pill growing, so `text-overflow` stays on underneath. |
| Estimates | Elapsed with no tilde, never a guess | The tilde means "estimate". Nothing reports remaining work, so a tilde on a number I invented would be the worst thing this UI could do. |
| Token counts | Sum input, output and cache writes; ignore cache reads | Cache reads are re-billed every turn. Summing them reports 1.2 *billion* for a session that spent 3.1M. |
| Dragging | Absolute screen-space offsets, one move per frame | Client coordinates are measured against a window that is moving, so every step-wise delta is wrong by however far the window just went. Totals from the press point can't drift. The offset is written to disk once on release, not sixty times a second. |
| Raise | Ask the terminal, don't fake keystrokes | Two sessions in one terminal share a pid. Terminal.app and iTerm2 expose a tty per tab, so the right window is a question you can ask them rather than a guess. |
| Fullscreen on raise | Off unless `PILL_FULLSCREEN=1` | The spec says raise *and* fullscreen. It was made opt-in because the pill disappeared over a fullscreen Space. On macOS 26.3.1 that no longer reproduces with Terminal.app: the pill stays over the fullscreen window, including through the same `AXFullScreen` call the raise makes. Still opt-in until someone decides; other terminals are unmeasured. |
| Data | One adapter, live by default | Everything comes from `read()`. Swapping it for the fixture is an env var, which keeps the demo reproducible. |
| Focus | `focusable: false` | The pill's whole job is to raise something else. It must never eat a keystroke. |
| Assets | `app://` protocol, `cache-control: no-store` | ES modules won't load into the opaque origin a `file://` page gets. And Chromium's cache lives in userData and outlives a restart, so a cached stylesheet makes an edit look like it did nothing. |

## Where the data comes from

| Field | Source |
| --- | --- |
| live sessions | `~/.claude/sessions/<pid>.json`, filtered to pids that still exist |
| repo | `cwd` from that file |
| model | last assistant record's `message.model`, remembered across turns |
| state | the newest *conversation turn* in `~/.claude/projects/<slug>/<id>.jsonl`. Transcripts also carry `system`, `attachment` and `summary` records; those are bookkeeping and get skipped, or the pill reads them as a session that has gone quiet |
| elapsed | `startedAt` from the session file |
| tokens | `message.usage` per turn, summed incrementally |
| today / week / burn rate | the same records, bucketed by day and by ten-minute slot |
| raise target | the process tree walked up to the first `.app` ancestor, plus the session's own tty |

Transcripts here run to 81MB, so the first poll reads what it needs and every poll after reads
only appended bytes: 85ms, then 2ms. The week's totals need every transcript, so that scan runs
in the background and the usage figures fill in a second after the first paint.

I don't read `~/.claude/stats-cache.json`. It looks like the right source — it has per-day token
totals — but on my machine it was five months stale, so it reported zero for today. The
transcripts are the live truth.

## Deviation: workers don't commit, BotWatch snapshots for them

The handoff's v3 model has worker branches accumulating the worker's own commits. They don't.
A worker edits files in its worktree; pilld commits that worktree to the branch the moment the
worker finishes a turn, from outside the sandbox. A follow-up message produces a follow-up turn
and its own snapshot. Merge only merges.

**Why.** Every spawned session runs inside Claude Code's Bash sandbox, which confines writes to
the session's own directory. A linked worktree's index and refs live in the *main* repo's `.git`,
which is outside that. The documentation says the sandbox handles this automatically —

> **Git worktrees**: when the working directory is a linked git worktree, the sandbox also allows
> writes to the main repository's shared `.git` directory so commands such as `git commit` can
> update refs and the index. Writes to `hooks/` and `config` inside that directory remain denied.

— and on Claude Code **2.1.280**, with worktrees placed beside the repo rather than inside it,
that allowance did not apply. Four runs against the real CLI, all failing identically on
`fatal: Unable to create '<repo>/.git/worktrees/<name>/index.lock'`: with an explicit
`sandbox.filesystem.allowWrite` for the git dir, with `--add-dir`, with both, and with neither.

**Why not the alternatives.**

| Option | Why not |
| --- | --- |
| `sandbox.excludedCommands: ["git"]` | Not a carve-out, an escape. Git runs arbitrary programs through aliases (`git -c alias.x='!sh -c …' x`), `core.sshCommand`, `core.pager`, and diff and merge drivers. Excluding git hands the worker an unsandboxed shell one step later. |
| Worktrees inside the repo | Puts worker directories where your file watchers, `tsc`, test runners and editor all see them — and it rests on the same automatic allowance that just didn't behave as documented. Trading a verified boundary for a guess. |

**What it costs.** Granular worker history: one snapshot per turn instead of the worker's own
commit sequence. Nothing in the brief's review flow needs that — per-branch +/−, the test result,
Review in terminal and Merge all work off the diff. One commit per turn is arguably tidier on main.

**What it required.** Workers are told in their brief that they cannot commit and that BotWatch
does it for them. Without that they spend tokens fighting `index.lock`, and a determined one goes
looking for a way around the sandbox. `git status` and `git diff` still work read-only inside the
sandbox, verified, and are how a worker checks its own work.

## The wide pill is 544

`Status Pill.dc.html` draws the wide pill at 440 and says that leaves "about 289px" for prose;
its own header markup — handle, badge, repo chip, model, rule, time — leaves about 180px. The
BotWatch README says 544, and that is what ships. At 544 the same markup leaves about 284px,
which at the spec's own 216px-per-34-characters is 45 characters, so the 46-character cap now
fits instead of ellipsising early. 440 survives only where the spec uses it for something else:
the prompt field and the ⌥⌘J permission line.

## Read next

- `src/format.js` — every number-to-text rule, pure.
- `src/model.js` — precedence: which colour wins, whose time is shown.
- `src/interact.js` — the time-based rules (hover grace, drag versus click).
- `electron/sessions.live.js` — discovery and the state machine.
- `electron/raise.js` — one script per terminal, because three scripting dictionaries don't
  deserve one clever abstraction.
- `tests/rules.test.js` — one test per sentence of the spec I'd otherwise have to be trusted on.
