#!/bin/bash
# The bun that package.json's packageManager names can read bun.lock, and
# bun.lock is current for package.json (issue #27).
#
# Runs `bun install --frozen-lockfile --ignore-scripts` on a copy of
# package.json and bun.lock in a scratch directory. A full install can't
# pass outside a Muse Space: @hatch/space-sdk is a file: tarball that exists
# only there. So the check passes only when bun's one complaint is that
# tarball, exactly:
#   error: ENOENT extracting tarball from @hatch/space-sdk
# Anything else fails, with bun's output. For example (bun 1.3.10 and 1.4.4,
# reproduced 2026-11-21):
# - a bun too old for the lockfile: "Unknown lockfile version" ... "lockfile
#   had changes, but lockfile is frozen";
# - a dependency changed or added in package.json without re-locking:
#   "lockfile had changes, but lockfile is frozen", and a note naming it.
#
# Usage: check-bun-reads-lock.sh <bun binary> <repo root>. Exit 0 when bun
# reads the lock as expected, 1 when it doesn't, 2 on a usage error.
set -uo pipefail

[ $# -eq 2 ] || { echo "usage: check-bun-reads-lock.sh <bun binary> <repo root>" >&2; exit 2; }
bun=$1
root=$2
command -v jq > /dev/null || { echo "::error::check-bun-reads-lock.sh needs jq, and it isn't on PATH"; exit 2; }
for f in package.json bun.lock; do
  [ -f "$root/$f" ] || { echo "::error file=$f::$f doesn't exist"; exit 1; }
done

want=$(jq -r '.packageManager // "" | ltrimstr("bun@")' "$root/package.json")
[ -n "$want" ] || { echo "::error file=package.json::package.json has no packageManager naming a bun"; exit 1; }
have=$("$bun" --version 2>&1) || { echo "::error::can't run $bun: $have"; exit 2; }
[ "$have" = "$want" ] || { echo "::error::$bun is bun $have, but packageManager names bun@$want"; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root/package.json" "$root/bun.lock" "$work/"
out=$(cd "$work" && "$bun" install --frozen-lockfile --ignore-scripts 2>&1)
# bun's first line is its banner ("bun install v1.4.4 (...)").
rest=$(printf '%s\n' "$out" | sed '1{/^bun install v/d;}')

expected="error: ENOENT extracting tarball from @hatch/space-sdk"
if [ "$rest" = "$expected" ]; then
  echo "bun $have reads bun.lock, and it's current for package.json (the only error is the platform SDK tarball, as expected outside a Space)"
  exit 0
fi
echo "::error file=bun.lock::bun $have (packageManager) doesn't install from bun.lock as expected: it should fail only on the @hatch/space-sdk tarball. Its output:"
printf '%s\n' "$out"
exit 1
