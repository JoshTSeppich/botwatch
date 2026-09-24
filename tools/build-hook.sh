#!/bin/sh
# Builds bw-hook for both Mac architectures and joins them into one binary in
# the plugin, which is what the app bundles and what `claude plugin install`
# copies. One universal file means one plugin, whichever .dmg you downloaded.
set -eu
cd "$(dirname "$0")/.."
out=claude-plugin/botwatch/bin
mkdir -p "$out"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --quiet --release --manifest-path bw-hook/Cargo.toml --target "$target"
done
lipo -create \
  bw-hook/target/aarch64-apple-darwin/release/bw-hook \
  bw-hook/target/x86_64-apple-darwin/release/bw-hook \
  -output "$out/bw-hook"
lipo -info "$out/bw-hook"
