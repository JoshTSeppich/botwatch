#!/bin/sh
# Commit what is staged, only if npm test exits 0 on exactly that tree.
# The staged tree is exported to a scratch dir; the working tree is untouched.
set -u
msg="$1"
root=$(git rev-parse --show-toplevel)
tree=$(mktemp -d)
git checkout-index -a --prefix="$tree/" || exit 1
ln -s "$root/node_modules" "$tree/node_modules"
# The socket tests need bw-hook; use the one built from the working tree.
[ -f "$root/claude-plugin/botwatch/bin/bw-hook" ] && mkdir -p "$tree/claude-plugin/botwatch/bin" && cp "$root/claude-plugin/botwatch/bin/bw-hook" "$tree/claude-plugin/botwatch/bin/"
(cd "$tree" && npm test >"$tree.log" 2>&1); code=$?
grep -E "^# (pass|fail|skipped)" "$tree.log" | tr '\n' ' '; echo
rm -rf "$tree" "$tree.log"
if [ $code -ne 0 ]; then echo "npm test exited $code — not committing"; exit $code; fi
git commit -q -m "$msg" && git log --oneline -1
