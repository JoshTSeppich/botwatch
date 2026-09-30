# v4 lease reports: token accounting, lease time, the lease contract

Reports for review. Nothing in the code changes until they are approved. Every number comes from a
run named beside it; the pricing comes from Anthropic's published page, fetched on 2026-09-30
(`platform.claude.com/docs/en/about-claude/pricing`).

## 1. Token accounting

### What the budget counts today, and where

One function decides it for everything BotWatch counts: `countUsage()` in `electron/tokens.js`.

```
input_tokens + output_tokens + cache_creation_input_tokens      (each at weight 1)
cache_read_input_tokens                                          (not counted: weight 0)
```

Every path goes through it, one count per API message at its largest sighting:

- the run budget and a fleet's leases: `Worker.meter` (`createMeter` in `tokens.js`) → `Run` ledger
  (`budget.record`) and `Fleet.#charge` → `lease.spent`;
- the result record's session total: `sessionTotal()` sums `inputTokens + outputTokens +
  cacheCreationInputTokens` from `modelUsage`, with the same weights;
- reconciliation from transcripts: `transcriptCounts()` and `createTranscriptCounter()`;
- the usage pill (today, week, burn rate): `sessions.live.js` through `createMessageCounter()`.

The weights are the same for every model. Output counts the same as input. A cache write counts
the same whether it goes to the 5-minute or the 1-hour cache.

### What the runs actually spent, by type

Every transcript BotWatch's integration runs left (`~/.claude/projects/*bw-it-*` and the v3 runs'
orchestrators), each message counted once by id, priced at list price per model:

| Role | Type | Tokens | Share of tokens | USD | Share of cost |
| --- | --- | ---: | ---: | ---: | ---: |
| worker | input | 17,748 | 0.0% | 0.02 | 0.1% |
| worker | output | 979,262 | 1.6% | 6.72 | 18.1% |
| worker | cache write, 5 min | 204,830 | 0.3% | 0.26 | 0.7% |
| worker | cache write, 1 hour | 9,504,128 | 15.3% | 23.42 | 63.0% |
| worker | cache read | 51,578,446 | 82.8% | 6.76 | 18.2% |
| orchestrator | output | 452,998 | 1.4% | 3.30 | 21.0% |
| orchestrator | cache write, 1 hour | 2,942,149 | 9.0% | 8.22 | 52.2% |
| orchestrator | cache read | 29,171,538 | 89.5% | 4.21 | 26.8% |
| hypervisor | output | 402,449 | 1.5% | 3.25 | 27.3% |
| hypervisor | cache write, 1 hour | 1,475,458 | 5.5% | 4.74 | 39.8% |
| hypervisor | cache read | 24,793,836 | 92.9% | 3.90 | 32.8% |

(Orchestrator and hypervisor input: 10,482 and 5,194 tokens, 0.1% of cost each.)

What this says:

- **98.5% of cache writes are 1-hour writes** (13,921,735 of 14,126,565), priced at 2× base input.
  Today's count treats them as 1×.
- **Cache reads are 83–93% of the tokens and 18–33% of the cost.** Today's count ignores them.
- **Output is about 1.5% of the tokens and 18–27% of the cost** (5× base input). Today's count
  treats it as 1×.

So the count is not a cost, in either direction.

### Proposal: budgets in micro-dollars at list price

One unit, `µ$` (a millionth of a US dollar at list price), across models and token types:

```
cost = input × base  +  5m write × 1.25·base  +  1h write × 2·base
     + cache read × 0.1·base (0.05·base on Opus 5.5)  +  output × output price
```

The per-model prices, per million tokens, checked on 2026-09-30:

| Model | Base input | 5-min cache write | 1-hour cache write | Cache read | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
| Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Sonnet 5.5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |

- **Where it would go:** everything in the code path above already has the message's model and
  its `cache_creation.ephemeral_5m/1h_input_tokens` split; only `countUsage` and `sessionTotal`
  would change.
- **The table is a data file, versioned,** and each lease records which version it was granted
  under (see the contract, section 3).
- **Plan users** aren't billed per token, but the same weights still say what each budget
  costs relative to another, which is what a budget is for.

### How the figures would change

Haiku workers from `it-fleet-attacks overshoot`, 24 runs between 2026-09-28 and 2026-09-30:

| | Counted today | In µ$ | Ratio |
| --- | ---: | ---: | ---: |
| A cold first step (the prefix written to the cache) | 21,339 to 21,570 | 42,671 to 43,829 | 2.0 |
| A warm first step | 10,470 to 11,900 | 22,028 to 29,141 | 2.1 to 2.5 |
| A whole run | 10,470 to 13,999 | 22,028 to 35,481 | 2.1 to 2.6 |

The ratio is **not constant** (2.0 to 2.6 in these runs), so today's budgets can't be converted by one
factor. What follows for each:

- **The floor** (the first-step floor, per role) would be derived in µ$: 22,000 counted becomes about
  44,000 µ$ for a Haiku worker (the largest cold first step, 43,829, rounded up), and twice that for
  Sonnet, since Sonnet's prices are twice Haiku's.
- **The reserve** would compare µ$ left against the largest step in µ$ (22,000 to 44,000 µ$ here
  instead of 10,500 to 21,500 counted). Its behaviour, stopping once what is left is under one step,
  is unchanged; its measured delivery (57–60% of a lease in the adversarial run) would need
  re-measuring in the new unit.
- **Overshoot and every budget in the docs** would be restated in µ$ from the same transcripts;
  no run would need repeating to report them, only to re-measure the reserve.

Not decided, and yours to decide: whether to switch, and whether a budget set by the user stays in
tokens in the UI (converted at grant) or is shown in dollars.

## 2. Lease time

**What a lease's time means**, to be stated in the design doc: awake, running time. It is not wall-clock
time. Measured: a lease with 19.9s left slept 7h41m and woke with 19.8s left.

**How recovery treats the time pilld was down: it doesn't, because a fleet doesn't survive a restart.**
Leases live only in pilld's memory (`Fleet.leases`), and nothing persists them. The recovery records
(`run.json` for the hypervisor and each orchestrator) hold processes, not leases. After a crash the
next launch's `recover()` stops the sessions it finds, and the fleet is gone. There is no lease left
to extend by the downtime. So the extension you asked for would have nothing to apply to, and I
haven't built a heartbeat.

It becomes meaningful with the lease contract below, once a lease is rebuilt from its event log.
Then a restarted pilld would credit each live lease with (restart − last heartbeat), appended as a
credit like sleep. That needs a heartbeat event every few seconds in the log. It's your call whether
fleets should resume after a crash at all. Today they end, and their branches are kept.

**Two things that differ from "awake, running time" today:**

- **Pauses count against lease time.** A lease's expiry is fixed at grant, and only system sleep is
  credited back. A lease paused by the user, the hypervisor or a spent budget keeps running out.
  If "running" means not paused, pauses need crediting too.
- **Expiry is stored and mutated** (`lease.expiresAt += asleep`), not derived from a log of credits.

## 3. Where the current code breaks the lease contract

The contract is in `docs/V4-V5-DESIGN.md` ("The lease contract"). Every place the code breaks it
today, fixed nowhere yet:

1. **`grant_lease` rewrites a live lease in place** (`fleet.js`, `grantLease`: `Object.assign(lease,
   next, …)`). It sets tokens, slots and expiry to new values, which breaks "immutable at grant" and
   "budget terms never change mid-lease". Contract terms that apply:
   - amendments are append-only;
   - tokens may only go up, within the global budget;
   - slots and time are budget terms, so no amendment at all.
2. **A lease can be shrunk** (`grantable` allows any size down to what was spent). The contract only
   allows raises.
3. **`grant_lease` revives a revoked or expired lease** (it resets `revoked`, `expired` and
   `reserveHit`). Under the contract, revoked and expired are states with legal transitions only.
   Revoked should be terminal; expired should come back only through the user.
4. **The hypervisor can revoke** (the `revoke_lease` tool). The contract says only the user revokes.
   This conflicts with the design's own hypervisor tool list, which includes `revoke_lease`. One of
   the two has to change; I'd make the hypervisor's tool a pause or a "wrap up" instead.
5. **There is no state machine.** State is spread across flags (`revoked`, `expired`, `reserveHit`)
   and the orchestrator's `haltReason`. There is no `released` state at all: a holder has no way to
   release a lease, and finishing (queueing) doesn't release it.
6. **Nothing is immutable or recorded at grant.** A lease has no holder, goal, contract version,
   accounting rules (token types and weights) or parent. The holder and goal live on the
   orchestrator entry, and the accounting rules are whatever `countUsage` says at the moment, so
   changing the code changes every live lease's terms.
7. **Remaining is stored, not derived:**
   - time is `expiresAt`, mutated by sleep credits;
   - tokens are `tokens − spent` with `tokens` mutable;
   - there are no credits or amendments to derive from.
8. **Counters:**
   - `spent` only goes up, as required;
   - there is no awake-time-used counter;
   - steps and largest step are kept on sessions, not on the lease.
9. **No event log, so a lease can't be rebuilt after a crash.** It isn't persisted at all (see
   section 2).
10. **Credits aren't append-only.** Sleep is applied by editing `expiresAt`. There is no record of
    each credit, except a line in the decision log.
11. **Safety can loosen mid-lease.** `resolve_lock` with `narrow <id> <globs>` replaces an
    orchestrator's claim with any globs, including broader ones. Under the contract a claim may only
    narrow mid-lease. (`give` only removes globs, so it tightens.) The other safety limits (the
    first-step floor, the read cap, the permission ceiling) only ever tighten or are fixed.
12. **Permissions beyond revoke:**
    - the holder can request (`request_lease`) but not release;
    - pilld counts, credits (sleep) and pauses, as intended;
    - the hypervisor grants and sequences, and also amends by overwriting (point 1).
