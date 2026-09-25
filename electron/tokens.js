// Counting tokens once. Shared by the usage pill (which reads transcripts) and
// the orchestrator's budget (which reads stream-json), because both got it
// wrong the same way: one API message is written as several records, one per
// content block, each carrying the message's usage. Summing records counted
// the same message two to five times. Measured on 2.1.282: three messages,
// nine stream records, 175,384 counted for a turn that cost 35,015; and over a
// week of transcripts on this machine, 2.28x.
//
// The unit is BotWatch's throughout: input + output + cache writes. Cache
// reads are re-billed every turn, so summing them would report billions.

export function countUsage(usage) {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

// The records of one message don't always carry the same usage: the stream
// reports output as it stood when the message began (1–3 tokens), and a
// transcript can hold an early record and a final one. So a message counts
// at the largest usage seen for it, and a later, larger sighting adds only
// the difference.
export function createMessageCounter() {
  const seen = new Map();
  return {
    // Returns the tokens this sighting adds: 0 for a repeat.
    add(id, usage) {
      const tokens = countUsage(usage);
      if (!id) return tokens;
      const before = seen.get(id) ?? 0;
      if (tokens <= before) return 0;
      seen.set(id, tokens);
      return tokens - before;
    },
  };
}

// Sums a result record's modelUsage: the session's own running total, across
// every model and including its subagents. Measured on 2.1.282 it matched the
// transcripts exactly (69,802 = main 14,341 + subagents 38,944 + 16,517),
// where result.usage covers only the main thread's last turn.
export function sessionTotal(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let total = 0;
  for (const m of Object.values(modelUsage)) {
    total += (m?.inputTokens ?? 0) + (m?.outputTokens ?? 0) + (m?.cacheCreationInputTokens ?? 0);
  }
  return total;
}

// One stream-json session. Counts each API message once as it arrives —
// main thread and subagents alike — then, at each result, trues up to the
// session's own total, which is where final output counts show up. Never
// goes down. `absorb` returns the tokens a record adds.
export function createMeter() {
  const messages = createMessageCounter();
  let live = 0; // counted from messages, this process
  let total = 0; // what has been reported, never less than live
  let reported = null; // { total, live } at the last result
  return {
    absorb(record) {
      if (!record || typeof record !== 'object') return 0;
      if (record.type === 'assistant' && record.message) {
        live += messages.add(record.message.id, record.message.usage);
      } else if (record.type === 'result') {
        const session = sessionTotal(record.modelUsage);
        if (session != null) reported = { total: session, live };
      } else {
        return 0;
      }
      // Since the last result, only what the stream has shown on top of it.
      const now = reported ? Math.max(live, reported.total + (live - reported.live)) : live;
      const added = Math.max(0, now - total);
      total += added;
      return added;
    },
    get total() {
      return total;
    },
  };
}
