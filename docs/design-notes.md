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
| Fullscreen on raise | Off unless `PILL_FULLSCREEN=1` | The spec says raise *and* fullscreen. Obeying it makes the pill disappear, because the overlay can't draw over a fullscreen Space on macOS. I kept the raise and made the fullscreen opt-in rather than ship a click that hides the thing you clicked. |
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

## The spec disagrees with itself in one place

It says the 440px pill leaves "about 289px" for prose, but its own header markup — handle, badge,
repo chip, model, rule, estimate — leaves about 180px. I followed the markup and kept the
46-character cap, so long copy ellipsises earlier than the spec's arithmetic predicts.

## Read next

- `src/format.js` — every number-to-text rule, pure.
- `src/model.js` — precedence: which colour wins, whose time is shown.
- `src/interact.js` — the time-based rules (hover grace, drag versus click).
- `electron/sessions.live.js` — discovery and the state machine.
- `electron/raise.js` — one script per terminal, because three scripting dictionaries don't
  deserve one clever abstraction.
- `tests/rules.test.js` — one test per sentence of the spec I'd otherwise have to be trusted on.
