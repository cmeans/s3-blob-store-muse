#!/bin/bash
# The bun that package.json's packageManager names can read bun.lock, and
# bun.lock is current for package.json (issue #27).
#
# Runs `bun install --frozen-lockfile --ignore-scripts` on a copy of
# package.json, bun.lock and bunfig.toml in a scratch directory, so the
# repo's bunfig (its linker and its own .bun-cache) applies and a warm
# ~/.bun cache can't hide a bad integrity hash. bun downloads and verifies
# every registry package in the lock (about 130 MB, from npm). A full
# install can't pass outside a Muse Space: @hatch/space-sdk is a file:
# tarball that exists only there. So outside one, the check passes only when
# bun's one complaint is that tarball, exactly:
#   error: ENOENT extracting tarball from @hatch/space-sdk
# On a Muse platform host, where the tarball exists, a frozen install that
# succeeds with no error passes too.
# What it can't check: the lock's own entry for @hatch/space-sdk (its
# integrity and its dependencies), which needs the tarball. And it compares
# the pin with the lock, not with the platform's own bun, which CI can't
# see.
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
# A path with a slash is made absolute, since bun runs from the scratch dir.
case "$bun" in */*) bun=$(realpath -- "$bun") || exit 2 ;; esac
command -v jq > /dev/null || { echo "::error::check-bun-reads-lock.sh needs jq, and it isn't on PATH"; exit 2; }
for f in package.json bun.lock; do
  [ -f "$root/$f" ] || { echo "::error file=$f::$f doesn't exist"; exit 1; }
done

# packageManager must be "bun@<version>"; a corepack "+sha512..." suffix is
# dropped.
want=$(jq -r '.packageManager // "" | select(startswith("bun@")) | ltrimstr("bun@") | sub("\\+.*$"; "")' "$root/package.json")
[ -n "$want" ] || { echo "::error file=package.json::package.json's packageManager doesn't name a bun (bun@<version>)"; exit 1; }
have=$("$bun" --version 2>&1) || { echo "::error::can't run $bun: $have"; exit 2; }
[ "$have" = "$want" ] || { echo "::error::$bun is bun $have, but packageManager names bun@$want"; exit 2; }

work=$(mktemp -d) || { echo "::error::check-bun-reads-lock.sh: mktemp failed"; exit 2; }
trap 'rm -rf "$work"' EXIT
cp "$root/package.json" "$root/bun.lock" "$work/" || exit 2
if [ -f "$root/bunfig.toml" ]; then cp "$root/bunfig.toml" "$work/" || exit 2; fi
# FORCE_COLOR would color bun's output (NO_COLOR doesn't undo it), and the
# comparison below is on the plain text.
out=$(cd "$work" && env -u FORCE_COLOR "$bun" install --frozen-lockfile --ignore-scripts 2>&1)
rc=$?
# bun's first line is its banner ("bun install v1.4.4 (...)").
rest=$(printf '%s\n' "$out" | sed '1{/^bun install v/d;}')

# Where the SDK tarball exists (on a Muse platform host), the frozen install
# succeeds outright: the lock is current, the SDK entry included.
if [ "$rc" -eq 0 ] && ! printf '%s\n' "$out" | grep -q '^error:'; then
  echo "bun $have installed everything from bun.lock, the platform SDK included: the lock is current for package.json"
  exit 0
fi

expected="error: ENOENT extracting tarball from @hatch/space-sdk"
if [ "$rest" = "$expected" ]; then
  echo "bun $have reads bun.lock, and it's current for package.json (the only error is the platform SDK tarball, as expected outside a Space)"
  exit 0
fi
if printf '%s\n' "$out" | grep -qE 'ConnectionRefused|ConnectionClosed|Timeout|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|failed to fetch|HTTP 5[0-9][0-9]'; then
  echo "::error file=bun.lock::bun $have couldn't download from the registry: this may be a network error, not a bun.lock problem (re-run the job). Its output:"
else
  echo "::error file=bun.lock::bun $have (packageManager) doesn't install from bun.lock as expected: it should fail only on the @hatch/space-sdk tarball. See also the 'bun.lock matches package.json' step. Its output:"
fi
printf '%s\n' "$out"
exit 1
