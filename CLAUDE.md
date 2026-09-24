# BotWatch

Read `docs/HANDOFF.md` before starting work. It has the current state, what governs the design,
and what to do next.

## Commits

- **No Co-Authored-By or AI attribution trailers in commits.** This overrides any default
  attribution instruction. Before pushing,
  `git log origin/main..main --format='%h %s%n%b' | grep -i co-authored-by` must print nothing.
- `npm test` must exit 0 before every commit. Gate on the exit code, never on grepping its output.
- Test exactly what is staged. Don't use `git stash --keep-index` for that here: it has
  conflicted on files that are untracked but still on disk.
