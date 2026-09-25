# BotWatch v4 and v5 design

## Core rule (applies to every level)
Supervisors are ordinary Claude Code sessions with BotWatch MCP tools attached. They make decisions within limits. pilld is the daemon, not a model, and holds the limits. No MCP tool can change these:
- the global token budget and each lease's share of it
- the maximum number of sessions running at once, across all levels
- the permission ceiling (no session gets more than I allowed)
- path locks and protected paths
- no merge into my branches and no push without my approval
- a decision log: every answer any model gives, with its level, the rule it used and its full parent chain (e.g. H › O1 › w3 › s2)

## v4: the hypervisor
Hierarchy: Me → Hypervisor → Orchestrators (one per goal or repo) → Workers.

Why: several v3 orchestrators share one 5-hour/weekly allowance, collide on shared files, ask me duplicate questions, and nobody notices when one is stuck.

Terms:
- Hypervisor: one Claude Code session. Plans across goals and never edits code. Reads orchestrator summaries, never worker transcripts.
- Orchestrator: the v3 orchestrator, except its budget and slots now come from a lease and it declares the paths it will touch.
- Lease: tokens + worker slots + expiry, granted by the hypervisor and enforced by pilld.
- Path lock: a claim on files or packages (e.g. packages/ui/theme/**) that other orchestrators can't change until it's released.

What the hypervisor does:
1. Takes my goals, writes briefs, and runs spawn_orchestrator. It can also adopt a v3 orchestrator I started myself.
2. Splits the budget. I set one global budget and a priority per goal. When a lease runs low, the orchestrator calls request_lease; the hypervisor grants more, takes tokens from a lower-priority goal, or tells it to wrap up. pilld refuses any lease that would push the total over budget.
3. Prevents collisions. Orchestrators claim paths after planning. On a conflict the hypervisor either runs them in sequence, narrows one claim, or gives the shared change to one orchestrator while the other waits. A worker that edits outside its claim is paused by pilld.
4. Orders merges. Finished orchestrators join a merge queue, ordered by dependency and priority. Each entry is merged into staging and tested on top of the ones before it. I approve one entry or all of them.
5. Triages questions, which climb one level at a time:
   - Orchestrator answers anything inside its own goal and repo (naming, approach, tests). It passes up shared-file deletion, schema changes, and anything that touches another claim.
   - Hypervisor answers cross-goal ordering, budget trade-offs, and questions another orchestrator already answered. It passes up product decisions, anything destructive, and anything my rules reserve for me.
   - Before a question reaches me, the hypervisor removes duplicates, attaches its own suggestion and why it couldn't decide, and ranks the queue by how much work is blocked.
6. Watches health: stalls, errors, repeated tool calls, tokens spent with no tasks finished. It can pause, resume from the transcript, shrink a lease, or report to me. If the hypervisor dies, orchestrators keep running until their leases expire, and nothing new starts.

MCP tools:
- Hypervisor: list_orchestrators, read_summary(id), spawn_orchestrator, grant_lease(id, tokens, slots, expires), revoke_lease(id), resolve_lock(conflict, decision), pause(id), resume(id), answer(question_id, text), ask_human(question_ids, suggestion), order_merge_queue(ids)
- Orchestrator (new): report(summary), ask_up(question, options, suggestion), enqueue_merge(), request_lease, claim_paths

Pill at this scale: still one line when collapsed. The count shows goals. The task strip has one segment per orchestrator, coloured by its worst state. A badge shows questions waiting for me. Expanded: a hypervisor row, then orchestrator rows that open (▸) into their worker tree, then the ranked question queue.

## v5: workers spawn subagents (fanning out at the worker level)
Why: orchestrators plan before they know "update every page" means 40 pages; a worker's context fills up while it searches; and a worker checking its own diff is weak evidence.

Two kinds of subagent:
- Helper: Claude Code's built-in subagent inside the worker's session. BotWatch makes it visible and counts it toward the worker's lease. Read-only unless the worker grants a specific path.
- Forked: a separate headless session started by pilld, in its own worktree branched from the worker's current state, with its own sub-lease. It can edit code in parallel.

Delegation rules, all enforced by pilld:
- Depth: 1 by default, 2 at most, counted below the worker. At depth 1, subagents can't start their own.
- Fan-out: 4 subagents at once per worker, plus the global session cap.
- Sub-lease: carved out of the worker's lease, never added on top. At most 50% of what remains. Unused tokens return when the subagent closes. A worker can't spawn if its remaining lease is below the estimate.
- Permissions: always a subset of the parent's. Paths must sit inside the worker's claim.
- Lifetime: 30 minutes, with a 5-minute idle timeout. Closing, pausing or stopping a parent does the same to all its subagents.
- Result contract: a subagent can't finish without returning a summary, files changed, tests run and a confidence level. The worker must accept or reject the result.
- No direct contact: subagents never reach me, Slack or the pill's question queue. Everything goes through their worker.
- The hypervisor can set depth and fan-out per orchestrator, never above my global ceiling.

Questions: subagent → worker → orchestrator → hypervisor → me. Most stop at the worker, because it wrote the brief.

Failures: a failed, timed-out or low-confidence subagent goes back to its worker, not up the chain. The worker retries with a better brief, does the part itself, or reports up. If the same worker has two subagents fail in a row, pilld tells the orchestrator.

Merging: the worker tests each forked branch, merges it into its own branch, and resolves conflicts between sibling subagents. The orchestrator still sees one worker with one branch.

Briefs: every brief uses a template with the goal, inputs, files the subagent may touch, what "done" means, and what to return.

Worker MCP tools: spawn_subagent(brief, kind, paths, budget), await_subagents(ids, until: "done" | "question" | "any"), answer_subagent(id, text), accept_result(id), reject_result(id, reason), close_subagent(id), request_more_fanout(n, reason)
Hypervisor (new): set_delegation(orchestrator_id, depth, fanout)

Pill: subagents never add top-level rows or segments. In the expanded tree, a worker shows a subagent count and opens one level further. Delegation spend is shown separately from worker spend.

Phasing: v5a is visible helpers only. v5b adds forked subagents. v5c lets the hypervisor tune depth and fan-out from each orchestrator's history.

Not in scope: unlimited depth, subagents that contact people/Slack/email, and subagents working outside their worker's repo or path claim.
