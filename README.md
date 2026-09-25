# BotWatch

I run four or five Claude Code sessions at once and I kept losing track of them. Which one is
working, which one has been sitting there for ten minutes waiting for me to answer a question,
which one died. Checking meant cycling through terminal windows.

Run agents in parallel. Review every change. Merge deliberately.

This is a small always-on-top pill that docks to the top edge of your terminal and tells you,
without you asking: how many sessions are live, what each one is doing, which one needs you, and
how much of the week's token budget is gone. Click a row and it brings that session's terminal
window to the front.

It listens to Claude Code's own hooks, through a small plugin, and reads what Claude Code already
writes to `~/.claude`. BotWatch itself sends nothing anywhere and has no telemetry. The sessions it
starts when you orchestrate talk to Anthropic's API like any Claude Code session.

## Why this exists

I built this as a take-home for a company I'm not naming. The brief was a design spec — sizes,
colours, states, motion, down to the pixel — and this is my implementation of it. I've kept
working on it since because I actually use it.

Where I departed from the spec, `docs/design-notes.md` says so and why.

## Install

Download the `.dmg` from [Releases](../../releases), drag it to Applications, open it.

It is not notarised, because I don't pay for a Developer ID, so macOS refuses the first open. On
macOS 15 and later, after it refuses, open **System Settings → Privacy & Security**, scroll to the
message about BotWatch, and click **Open Anyway**. On older macOS, right-click the app, choose
**Open**, then **Open** again. Either way, macOS remembers after once.

Or, from Terminal, remove the download's quarantine flag:

```sh
xattr -dr com.apple.quarantine /Applications/BotWatch.app
```

Then install the Claude Code plugin that ships inside the app. It is what tells the pill a
session is waiting on a permission prompt or a question:

```sh
claude plugin marketplace add /Applications/BotWatch.app/Contents/Resources/claude-plugin
claude plugin install botwatch@botwatch
```

New sessions pick it up; ones already running keep working without it until you restart them.
Every hook runs `bw-hook`, which hands the event to the pill over a local socket and exits. If
BotWatch isn't running it exits 0 without a word — measured at under 7ms on Apple silicon, and
under 50ms in every case I could construct — so the plugin never slows Claude Code down. The one
exception is the very first run after installing: macOS spends about 0.3s checking a binary it
hasn't seen before, once. Without the plugin the pill
still works, from transcripts alone, with the limits listed under "What it can't tell you".

To update after installing a new BotWatch: `claude plugin marketplace update botwatch`, then
`claude plugin update botwatch@botwatch`. To remove it: `claude plugin uninstall botwatch@botwatch`.

**To orchestrate** (new in 0.2.0), press `⌥⌘O` over the pill. There is nothing more to grant:
workers are Claude Code sessions that use your existing `claude` login, so the `claude` CLI has to
be installed and logged in. Each worker runs in Claude Code's sandbox. It can write only inside
its own git worktree, it can't read your credential files, and it reaches only Anthropic's API.
**Package installs** is off by default. Turn it on in the setup panel for a run whose workers
need npm, PyPI or crates.io. What workers may do (**Workers may** in setup) starts at
`acceptEdits` and is never allowed past the mode your own sessions run in. Nothing a worker does
reaches your branch until you review it and click Merge. See "Orchestrating" below.

**It has no Dock icon.** It's an accessory app: the pill is the interface. There's a small pill
glyph in the menu bar for the one thing the pill can't do — quitting. Right-clicking the pill
gives you the same menu.

If you'd rather build it yourself:

```sh
git clone https://github.com/JoshTSeppich/botwatch
cd botwatch
npm install
npm start          # run it
npm run dist       # build the .dmg into dist/ (builds bw-hook first; needs Rust with the
                   # aarch64-apple-darwin and x86_64-apple-darwin targets)
```

## Permissions

On first run the pill says **Allow access to your terminal**. Click it. macOS asks for two
things, in two different places, and it needs both:

- **Accessibility** — to know where your terminal window is, so the pill can sit on its top edge.
- **Automation** — to bring a terminal window to the front when you click a row.

Clicking the pill triggers the system prompts. If you already said no once, macOS won't ask
again, so clicking it opens the right pane of System Settings instead. The pill notices the
moment you grant access — no relaunch.

That's all it asks for. No network, no disk access beyond `~/.claude`, no login. Orchestrating
asks for nothing extra: its sessions use the `claude` login you already have. The hook socket
is `~/.claude/botwatch/pilld.sock`, readable and writable by you alone.

## What you're looking at

```
⠿ ● 3  api-gateway  Refactoring auth, running tests   opus 5 │ ~4m
```

- **Dot** — red if any session stopped, amber if one is waiting on you (a permission prompt, a
  question, or a finished turn), green if any is working,
  grey if nothing is running. Worst state wins, because the bad one is the one you need to see.
- **Count** — live sessions.
- **Repo chip** — the git root. Reads `3 repos` when they span more than one.
- **The sentence** — what the busiest session is doing, in plain language.
- **Time** — elapsed on the longest-running session, or `now` when something is waiting on you.

Hover and it expands into a row per session: state, what it's doing, repo, model, time, and an
`×` to hide a session you don't care about. A session waiting on you says which kind of waiting:
`Needs permission to run npm test`, or `Asks: Which database should I use?`. Hiding it doesn't touch the process. Click a row to
raise that terminal. Drag the four-dot handle to move the pill; double-click the handle to put it
back.

The second pill is the token budget: this week against your plan limit, this session, today, burn
rate, and when the week resets. Set `PILL_WEEKLY_TOKEN_LIMIT` to your plan's ceiling or the
percentage is measured against a guess of 40M.

## Orchestrating

`⌥⌘O` opens the setup panel: a goal, a repo, a model, how many workers at once, a token budget,
what workers may do (never more than your own sessions), the test command, and whether workers may
install packages (off by default: they reach Anthropic and nothing else). Start hands the
goal to an orchestrator session, which splits it into tasks and starts a worker per task, each in
its own git worktree on a `bw/` branch. The pill shows the run as a tree while it works.

When a worker finishes, BotWatch commits its worktree to its branch and runs your tests against
that commit, sandboxed: no network, no writes outside the worktree. **Review and merge** then
shows, per worker: the branch, the snapshot commit and when it was taken, the test command and its
result, and the files, with edits and new files listed separately. Files that look like they
shouldn't be merged — a `.env`, build output, keys, anything that smells of a secret — are flagged,
and Merge refuses until you tick each one by name. What merges is the exact commit you reviewed;
if a worker ran again since, Merge refuses and asks you to look again. Each branch lands as its own
`--no-ff` merge naming the worker and the commit. Nothing is ever pushed.

## What stops a worker touching your work

The long version, with every measurement, is [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
Everything in this section reduces blast radius — how much a worker can reach when it goes wrong
— and none of it is a formal security boundary.

Two different problems, and conflating them is a mistake I made twice. **Refs and history** are
one problem. **Files on disk** are another, and nothing about git solves it: any session with a
shell, running as you, can write anywhere you can.

### Refs and history

1. **A PreToolUse hook** denies `git merge`, `push`, `rebase`, `reset`, `cherry-pick`, forced
   branch moves and `update-ref` by pattern. It catches the obvious spelling and nothing more:
   `g=merge; git $g main` walks straight past it.
2. **A `reference-transaction` hook** refuses *any* move of a protected ref from a session
   BotWatch spawned, with no exceptions and nothing to unlock. When you click Merge, **BotWatch
   performs the merge itself**, from outside that environment, so no session ever needs permission
   to move a branch. Your own git is untouched: the check only applies when `BOTWATCH_GUARD` is
   set. An existing `reference-transaction` hook of yours is chained, not replaced.
3. **The spawned environment** has no usable push target and cannot prompt for credentials.

A rejected fast-forward has already written the index and working tree by the time the ref move is
refused, so the hook undoes exactly the paths that merge wrote. Not the whole index — doing that
destroyed staged and unstaged work in testing, which was worse than the hole it closed.

A worktree is *not* one of these layers: worktrees share refs with the repo they came from.

### Files on disk

Every session BotWatch spawns is denied `Write`, `Edit` and `NotebookEdit` into your checkout by
absolute path, and the orchestrator runs in its own directory rather than your repo.

**Bash is confined by Claude Code's own sandbox** (Seatbelt on macOS, bubblewrap on Linux), which
every spawned session gets through `--settings`: `sandbox.enabled`, `allowUnsandboxedCommands:
false` so a command that can't be sandboxed doesn't fall through to the permission flow, and
`failIfUnavailable: true` so a session nobody is watching stops rather than running unsandboxed.
Writes are confined to the session's own directory and the network to a short allowlist that
deliberately leaves out GitHub.

Measured at `bypassPermissions`, the worst case:

| Attempt | Result |
| --- | --- |
| `echo pwned > /your/repo/file` | blocked |
| `rm -f /your/repo/.git/hooks/reference-transaction` | blocked |
| writing in its own worktree | works |

That closes "a shell can delete the hook", which earlier versions of this file listed as open.

**Workers don't commit.** The sandbox keeps them out of the main repo's `.git`, which is exactly
what stops them touching `hooks/`. So a worker edits files in its worktree and BotWatch commits
that worktree to its branch — as pilld, outside the sandbox — at the moment you click Merge. It's
why `worker_diff` reports uncommitted work rather than committed history.

**Separate clones would not fix this.** They fix refs and history. A worker in a separate clone can
still write to your checkout by absolute path, with no git involved.

### If BotWatch dies mid-run

Quitting BotWatch stops a run cleanly. If it's killed or crashes instead, the next launch finds
the run it left behind and cleans up: it stops the sessions that were still running, takes its ref
hook back out of your repo (a hook of yours stays as it is), and keeps every branch, because the
branches are the work. The setup panel says what it recovered. A worker that crashes mid-task
has its partial work saved to its branch for you to look at, but it can't be merged.

### The holes, in the order I'd expect them to be hit

- **Whatever a worker reads goes to Anthropic's API** as part of its conversation, like any Claude
  Code session. No setting changes that.
- **Secret locations are denied, but it's a denylist, not confinement.** Workers can't read
  `~/.ssh`, `~/.aws`, the other usual credential files, keychains or browser profiles (measured,
  at both the Read tool and Bash). Anything you keep elsewhere, they can.
- **Package installs are off unless you turn them on for a run.** Off, a worker reaches only
  Anthropic. On, it also reaches npm, PyPI and crates.io, and a request there can carry what it
  read. [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) has the measurements and the rest.
- `BOTWATCH_GUARD= git merge` still gets past the ref hook's env check. The sandbox stops the
  merge from reaching your checkout's `.git`, so this is narrower than it was, but the env check
  is a marker and not a lock.
- `git reset --hard` overwrites the working tree *before* touching any ref — inside the worker's
  own worktree, where the sandbox confines it. Your checkout is out of reach; the worker's own
  work is not.
- Anything the sandbox itself doesn't cover. It reduces blast radius; it is not a formal
  security boundary.

Ref and history safety would get better with a clone per worker —
[docs/tickets/separate-clones.md](docs/tickets/separate-clones.md), not built. File safety is the
OS sandbox above, which is built and measured.

## What it can't tell you

I'd rather say this up front than have you find it.

- **There is no time estimate.** Nothing in a session reports how much work is left, so the pill
  shows elapsed time, without a tilde. If you see `~4m` it came from something that actually
  reported an estimate. Everything else is time spent, not time left.
- **Without the plugin, "waiting on you" only catches a finished turn.** A session started
  before you installed it, or on a machine without it, is read from its transcript, where a
  permission prompt looks identical to a long test run — both are an open tool call with no
  result. With the plugin, a permission prompt and a question each turn the pill amber the moment
  they appear, and say which one they are.
- **Nothing reports the moment you answer a prompt.** No hook fires on approve or deny; the next
  one is when the tool finishes. So the pill clears the amber from Claude Code's own session
  file, which flips to busy about 70ms after you answer, and it notices on its next one-second
  poll. If a future Claude Code stops writing that field, an approved slow command stays amber
  until it finishes.
- **A session that's killed says nothing.** No hook fires on `kill -9` or a crash, so a row
  leaves when its process is gone, found on the same one-second poll.
- **The summary is blunt.** It says `running npm test` or `editing render.js`, because the tool
  in flight is what's actually knowable. It is not going to write you a nice sentence.
- **Tab targeting only works on scriptable terminals.** Terminal.app and iTerm2 expose a tty per
  tab, so a click lands on the exact window or tab. WezTerm and kitty go through their CLIs.
  Ghostty, Warp and the Claude desktop app have no equivalent, so you get the app raised and
  nothing finer.
- **Fullscreen is measured for two terminals, on one macOS.** Clicking a row raises that terminal
  and puts it in native fullscreen, as the spec asks; `PILL_FULLSCREEN=0` turns that off. On macOS
  26.3.1 the pill stays on top of a native-fullscreen Terminal.app or iTerm2 window, including
  through the raise itself. I have not measured Ghostty, WezTerm, kitty or Warp in fullscreen, or
  older macOS, where an earlier version of this README said the pill ended up behind.
- **macOS only, really.** The Windows and X11 raise paths are written but I have not run them.
  Wayland has no way for an app to raise itself, so that one is missing rather than faked.

## How it decides

With the plugin, from hooks:

| It shows | Because |
| --- | --- |
| working | you sent a prompt, a tool started or finished, or you answered a prompt |
| needs permission | `PermissionRequest`, or the `permission_prompt` Notification six seconds later |
| asks you a question | the session called `AskUserQuestion` — which also raises a permission-shaped Notification, and is still shown as a question |
| waiting on you | `Stop`: the turn ended, so it's your move |
| stopped | a turn open for ten minutes whose last tool failed |
| stuck | a turn open for ten minutes with nothing happening |

Which sessions exist comes from `~/.claude/sessions/`, checked against their pids every second,
so a session started before BotWatch shows up the moment it launches. Until a session's first
hook arrives, its state is read from its transcript, by the rules below; after that the
transcript only supplies the model and the token counts.

| From the transcript | Because |
| --- | --- |
| working | the newest turn is still open — a tool is running |
| waiting on you | the turn ended, so it's your move |
| stopped | the last thing that happened was a failed command, and nothing since |
| stuck | a turn has been open with nothing happening for ten minutes |

Token counts sum input, output and cache writes. They ignore cache reads, which get re-billed
every turn — counting those reports a billion tokens for a session that spent three million.

## Building on it

Everything the pill shows comes from one function, `read()` in `electron/sessions.live.js`. Swap
it and the pill will show whatever you want. Hook events arrive in `electron/pilld.js` and are
folded into session state by `electron/registry.js`, which is pure and tested transition by
transition. `PILL_TRACE=1 npm start` logs every hook event, the state it produced, and each row
arriving and leaving. `PILL_MOCK=1 npm start` runs it on a fixture
instead, which is also what `npm run demo` serves at `/demo.html` for poking at the states
without waiting for real ones.

`npm test` runs the rules — truncation, which colour wins, what the time slot says when nothing
is known — and every hook transition. With `bw-hook` built (`npm run hook`) it also sends events
through the real binary and a real socket, and checks that it exits 0 inside 50ms with nothing
listening.
