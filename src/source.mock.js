// The demo data source. The overlay cannot derive a session's state, its plain
// language summary or its estimate from anything on disk, so the adapter is the
// single source of truth and this file is the stand-in for one. Scenario names
// match the states the spec sheet draws.

const WEEKLY_LIMIT = 40_000_000;

function session(index, repo, model, state, summary, etaSeconds, ageSeconds, pid) {
  return {
    id: `s${index}`,
    index,
    repo,
    model,
    state,
    summary,
    etaSeconds,
    startedAt: Date.now() - ageSeconds * 1000,
    pid,
  };
}

const SCENARIOS = {
  working: () => ({
    headline: 'Refactoring auth, running tests',
    sessions: [
      session(1, '/Users/me/work/api-gateway', 'sonnet 5', 'working', 'Running the auth test suite', 244, 600, 4101),
      session(2, '/Users/me/work/api-gateway', 'sonnet 5', 'working', 'Reading the session guard', 95, 320, 4102),
      session(3, '/Users/me/work/api-gateway', 'sonnet 5', 'working', 'Patching the rate limiter', 50, 180, 4103),
    ],
  }),
  waiting: () => ({
    headline: 'Waiting for your answer in session 2',
    sessions: [
      session(1, '/Users/me/work/api-gateway', 'sonnet 5', 'working', 'Running the auth test suite', 244, 600, 4101),
      session(2, '/Users/me/work/web-app', 'opus 5', 'waiting', 'Asking you a question', null, 320, 4102),
      session(3, '/Users/me/work/billing-svc', 'sonnet 5', 'working', 'Writing a database migration', 50, 180, 4103),
      session(4, '/Users/me/work/infra', 'haiku 4.5', 'working', 'Planning the rollout', 610, 90, 4104),
    ],
  }),
  errored: () => ({
    headline: null,
    sessions: [
      session(1, '/Users/me/work/api-gateway', 'sonnet 5', 'working', 'Running the auth test suite', 244, 600, 4101),
      session(2, '/Users/me/work/web-app', 'opus 5', 'waiting', 'Asking you a question', null, 320, 4102),
      session(3, '/Users/me/work/billing-svc', 'sonnet 5', 'working', 'Writing a database migration', 50, 180, 4103),
      session(4, '/Users/me/work/infra', 'haiku 4.5', 'errored', 'Stopped — the last command failed', null, 90, 0),
      session(5, '/Users/me/work/docs-site', 'haiku 4.5', 'working', 'Rebuilding the search index', 20, 40, 4105),
      session(6, '/Users/me/work/cli', 'sonnet 5', 'working', 'Bumping the lockfile', 8, 25, 4106),
    ],
  }),
  empty: () => ({ headline: null, sessions: [] }),
};

let scenario = 'working';
let terminalWidth = 1200;
const born = Date.now();

export function setScenario(name) {
  if (SCENARIOS[name]) scenario = name;
}

export function setTerminalWidth(width) {
  terminalWidth = width;
}

export function read() {
  const { headline, sessions } = SCENARIOS[scenario]();
  const elapsed = (Date.now() - born) / 1000;
  const used = Math.min(WEEKLY_LIMIT, 24_400_000 + elapsed * 200);
  return Promise.resolve({
    headline,
    // Estimates count down so the 1Hz refresh is visible; tabular figures keep
    // the right edge still while they do.
    sessions: sessions.map((s) => ({
      ...s,
      etaSeconds: s.etaSeconds == null ? null : Math.max(1, s.etaSeconds - Math.floor(elapsed) % 30),
    })),
    usage: {
      weeklyUsed: used,
      weeklyLimit: WEEKLY_LIMIT,
      sessionTokens: 1_200_000,
      todayTokens: 3_800_000,
      burnRatePerHour: 840_000,
      resetsAt: nextMonday(),
    },
    terminal: { width: terminalWidth },
  });
}

// A session whose pid we cannot resolve is how the stale-handle path is
// reachable in the demo.
export function isStale(id) {
  const { sessions } = SCENARIOS[scenario]();
  return sessions.find((s) => s.id === id)?.pid === 0;
}

function nextMonday() {
  const at = new Date();
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() + ((8 - at.getDay()) % 7 || 7));
  return at.getTime();
}
