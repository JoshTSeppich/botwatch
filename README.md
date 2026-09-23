# BotWatch

I run four or five Claude Code sessions at once and I kept losing track of them. Which one is
working, which one has been sitting there for ten minutes waiting for me to answer a question,
which one died. Checking meant cycling through terminal windows.

So this is a small always-on-top pill that docks to the top edge of your terminal and tells you,
without you asking: how many sessions are live, what each one is doing, which one needs you, and
how much of the week's token budget is gone. Click a row and it brings that session's terminal
window to the front.

It reads what Claude Code already writes to `~/.claude`. It does not talk to the network, and it
has no telemetry.

## Why this exists

I built this as a take-home for a company I'm not naming. The brief was a design spec — sizes,
colours, states, motion, down to the pixel — and this is my implementation of it. I've kept
working on it since because I actually use it.

Where I departed from the spec, `docs/design-notes.md` says so and why.

## Install

Download the `.dmg` from [Releases](../../releases), drag it to Applications, open it.

It is not notarised — I don't pay for a Developer ID — so the first open needs a right-click:

```
right-click BotWatch.app → Open → Open
```

Do that once and macOS remembers.

**It has no Dock icon.** It's an accessory app: the pill is the interface. There's a small pill
glyph in the menu bar for the one thing the pill can't do — quitting. Right-clicking the pill
gives you the same menu.

If you'd rather build it yourself:

```sh
git clone https://github.com/JoshTSeppich/botwatch
cd botwatch
npm install
npm start          # run it
npm run dist       # build the .dmg into dist/
```

## Permissions

On first run the pill says **Allow access to your terminal**. Click it. macOS asks for two
things, in two different places, and it needs both:

- **Accessibility** — to know where your terminal window is, so the pill can sit on its top edge.
- **Automation** — to bring a terminal window to the front when you click a row.

Clicking the pill triggers the system prompts. If you already said no once, macOS won't ask
again, so clicking it opens the right pane of System Settings instead. The pill notices the
moment you grant access — no relaunch.

That's all it asks for. No network, no disk access beyond `~/.claude`, no login.

## What you're looking at

```
⠿ ● 3  api-gateway  Refactoring auth, running tests   opus 5 │ ~4m
```

- **Dot** — red if any session stopped, amber if one is waiting on you, green if any is working,
  grey if nothing is running. Worst state wins, because the bad one is the one you need to see.
- **Count** — live sessions.
- **Repo chip** — the git root. Reads `3 repos` when they span more than one.
- **The sentence** — what the busiest session is doing, in plain language.
- **Time** — elapsed on the longest-running session, or `now` when something is waiting on you.

Hover and it expands into a row per session: state, what it's doing, repo, model, time, and an
`×` to hide a session you don't care about. Hiding it doesn't touch the process. Click a row to
raise that terminal. Drag the four-dot handle to move the pill; double-click the handle to put it
back.

The second pill is the token budget: this week against your plan limit, this session, today, burn
rate, and when the week resets. Set `PILL_WEEKLY_TOKEN_LIMIT` to your plan's ceiling or the
percentage is measured against a guess of 40M.

## What stops a worker touching your branches

Three layers, weakest first, and I'd rather name the hole than imply there isn't one.

1. **A PreToolUse hook** denies `git merge`, `push`, `rebase`, `reset`, `cherry-pick`, forced
   branch moves and `update-ref` by pattern. It catches the obvious spelling and nothing more:
   `g=merge; git $g main` walks straight past it.
2. **A `reference-transaction` hook** rejects any move of a protected ref from a session BotWatch
   spawned, whatever produced it — merge, reset, `update-ref`, a command spelled to dodge the
   regex. Protected refs move only while a one-time token is present, and that token is written
   on your Merge click and deleted straight after. Your own git is untouched: the check only
   applies when `BOTWATCH_GUARD` is set, which only BotWatch's sessions have. An existing
   `reference-transaction` hook of yours is chained, not replaced.
3. **The spawned environment** has no usable push target and cannot prompt for credentials.

A worktree is *not* one of these layers. Worktrees share refs with the repo they came from, so a
worker can move `refs/heads/main` from inside its own tree, and the orchestrator isn't in a
worktree at all. I said otherwise earlier and it was wrong.

**The remaining hole:** a session with a shell can delete the hook, or run `BOTWATCH_GUARD= git
merge`. Nothing in-repo survives an agent that goes looking for it. The airtight version gives
each worker a **separate clone** with no path back to your repo, and merges by fetching from that
clone on your click. That's the right answer and I haven't built it yet.

## What it can't tell you

I'd rather say this up front than have you find it.

- **There is no time estimate.** Nothing in a session reports how much work is left, so the pill
  shows elapsed time, without a tilde. If you see `~4m` it came from something that actually
  reported an estimate. Everything else is time spent, not time left.
- **"Waiting on you" only catches a finished turn.** A session sitting on a permission prompt
  looks identical to one running a long test suite — both are an open tool call with no result.
  So the amber state catches "it asked you a question and stopped", but not "it wants you to
  approve a command", which is the more annoying of the two.
- **The summary is blunt.** It says `running npm test` or `editing render.js`, because the tool
  in flight is what's actually knowable. It is not going to write you a nice sentence.
- **Tab targeting only works on scriptable terminals.** Terminal.app and iTerm2 expose a tty per
  tab, so a click lands on the exact window or tab. WezTerm and kitty go through their CLIs.
  Ghostty, Warp and the Claude desktop app have no equivalent, so you get the app raised and
  nothing finer.
- **It won't draw over a fullscreen app.** macOS keeps a native-fullscreen app on its own Space
  and I have not found a way in. If your terminal is fullscreen, the pill is behind it.
- **macOS only, really.** The Windows and X11 raise paths are written but I have not run them.
  Wayland has no way for an app to raise itself, so that one is missing rather than faked.

## How it decides

| It shows | Because |
| --- | --- |
| working | the newest turn is still open — a tool is running |
| waiting on you | the turn ended, so it's your move |
| stopped | the last thing that happened was a failed command, and nothing since |
| stuck | a turn has been open with nothing happening for ten minutes |

Token counts sum input, output and cache writes. They ignore cache reads, which get re-billed
every turn — counting those reports a billion tokens for a session that spent three million.

## Building on it

Everything the pill shows comes from one function, `read()` in `electron/sessions.live.js`. Swap
it and the pill will show whatever you want. `PILL_MOCK=1 npm start` runs it on a fixture
instead, which is also what `npm run demo` serves at `/demo.html` for poking at the states
without waiting for real ones.

`npm test` runs the rules — truncation, which colour wins, what the time slot says when nothing
is known.
