#!/usr/bin/env bash
# Cut a release:  scripts/release.sh 0.2.0
# Bumps package.json, runs the tests, commits, tags vX.Y.Z, pushes, and publishes a GitHub release with generated notes.
# Installed boards find it through `board update` (and the daily check when the board starts).
set -euo pipefail
cd "$(dirname "$0")/.."
v="${1:-}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: scripts/release.sh X.Y.Z" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean" >&2; exit 1; }
[ "$(git branch --show-current)" = master ] || { echo "release from master" >&2; exit 1; }
git rev-parse "v$v" >/dev/null 2>&1 && { echo "tag v$v exists" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
bun test
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$v\"/" package.json
git commit -qam "release v$v"
git tag "v$v"
git push origin master "v$v"
gh release create "v$v" --title "v$v" --generate-notes
echo "released v$v"
