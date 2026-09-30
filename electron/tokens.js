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
  let largest = 0;
  let firstId = null;
  let sum = 0;
  const set = (id, tokens) => {
    const before = seen.get(id) ?? 0;
    if (firstId == null) firstId = id;
    if (tokens <= before) return 0;
    seen.set(id, tokens);
    if (tokens > largest) largest = tokens;
    sum += tokens - before;
    return tokens - before;
  };
  return {
    // The session's first message, counted: its first step.
    get first() {
      return firstId == null ? 0 : seen.get(firstId) ?? 0;
    },
    // The largest single message counted so far: a session's largest step.
    get largest() {
      return largest;
    },
    // Every message, each at its largest.
    get sum() {
      return sum;
    },
    ids() {
      return seen.keys();
    },
    // The messages not in `ids`: those since a result, say.
    sumExcept(ids) {
      let n = 0;
      for (const [id, v] of seen) if (!ids.has(id)) n += v;
      return n;
    },
    // Returns the tokens this sighting adds: 0 for a repeat.
    add(id, usage) {
      const tokens = countUsage(usage);
      if (!id) {
        sum += tokens;
        return tokens;
      }
      return set(id, tokens);
    },
    // The same, from a count already made (a transcript's, for one message).
    addCount(id, tokens) {
      return id ? set(id, tokens) : 0;
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
  let total = 0; // what has been reported; never goes down
  let reported = null; // { total, ids } at the last result: its session total, and the messages it covered
  // Every message at its largest sighting (stream or transcript); after a
  // result, its session total plus only the messages since. Upgrading a
  // message the result already covered adds nothing, so nothing is counted
  // twice.
  const settle = () => {
    const now = reported ? Math.max(messages.sum, reported.total + messages.sumExcept(reported.ids)) : messages.sum;
    const added = Math.max(0, now - total);
    total += added;
    return added;
  };
  return {
    absorb(record) {
      if (!record || typeof record !== 'object') return 0;
      if (record.type === 'assistant' && record.message) {
        messages.add(record.message.id, record.message.usage);
      } else if (record.type === 'result') {
        const session = sessionTotal(record.modelUsage);
        if (session != null) reported = { total: session, ids: new Set(messages.ids()) };
      } else {
        return 0;
      }
      return settle();
    },
    get total() {
      return total;
    },
    // A transcript's counts, one per message id at its largest: the output
    // the stream never reported (an interrupted turn, or a turn still
    // going). Merged per message, so a message is never counted twice, and
    // the count never goes down.
    merge(counts) {
      for (const [id, n] of counts) messages.addCount(id, n);
      return settle();
    },
    // The largest single API message this session has sent. What one more
    // step could cost.
    get largestStep() {
      return messages.largest;
    },
    // Its first message: the system prompt going into the cache, mostly. The
    // one step no reserve can cover, since the session has none before it.
    get firstStep() {
      return messages.first;
    },
  };
}

// A session's spend from its own transcripts: the main one and its
// subagents', one count per API message at its largest sighting. What the
// count is reconciled against after a pause or an interrupt.
export function transcriptCounts(files, read) {
  const counts = new Map();
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.type !== 'assistant' || !r.message?.id) continue;
      counts.set(r.message.id, Math.max(counts.get(r.message.id) ?? 0, countUsage(r.message.usage)));
    }
  }
  return counts;
}

export function transcriptSpend(files, read) {
  let total = 0;
  for (const v of transcriptCounts(files, read).values()) total += v;
  return total;
}

// The same count, read incrementally: only what was appended to each file
// since the last look, and a half-written last line waits. For truing a
// session's count up while its turn is still going, which happens often.
export function createTranscriptCounter({ size, readAt }) {
  const state = new Map(); // file -> { offset, seen: Map }
  const read = (file) => {
    let st = state.get(file);
    if (!st) state.set(file, (st = { offset: 0, seen: new Map() }));
    const length = size(file);
    if (length < st.offset) {
      st.offset = 0;
      st.seen = new Map();
    }
    if (length > st.offset) {
      const text = readAt(file, st.offset, length - st.offset);
      const cut = text.lastIndexOf('\n');
      if (cut !== -1) {
        for (const line of text.slice(0, cut).split('\n')) {
          if (!line.includes('"assistant"')) continue;
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if (r.type !== 'assistant' || !r.message?.id) continue;
          st.seen.set(r.message.id, Math.max(st.seen.get(r.message.id) ?? 0, countUsage(r.message.usage)));
        }
        st.offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
      }
    }
    return st.seen;
  };
  return {
    // One count per message id, at its largest, across the files.
    counts(files) {
      const out = new Map();
      for (const file of files) for (const [id, v] of read(file)) out.set(id, Math.max(out.get(id) ?? 0, v));
      return out;
    },
    total(files) {
      let n = 0;
      for (const v of this.counts(files).values()) n += v;
      return n;
    },
  };
}
