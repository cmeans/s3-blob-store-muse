#!/bin/bash
# A PR adds drizzle migrations; it never changes one already on the base
# branch (issue #40).
#
# drizzle-orm's migrator records each migration's hash and `when` as it
# applies it, but decides what to run from the latest `when` alone and never
# compares hashes. So an existing database never re-runs an edited
# migration: the edit
# reaches a fresh database and never a live console, and the two drift
# apart. Both doc checks pass on such an edit, since the edited files agree
# with each other.
#
# Checks, against <base> (a commit):
# - no drizzle/*.sql that exists on <base> is modified, deleted or renamed;
# - <base>'s journal entries are, unchanged and in order, the first entries
#   of the new journal (new migrations are added after them).
#
# Usage: check-drizzle-history.sh <base commit>, run from the repo root with
# <base> fetched. Exit 0 when only additions, 1 with an ::error line for each
# change, 2 on a usage error. Needs git and jq.
set -uo pipefail

[ $# -eq 1 ] || { echo "usage: check-drizzle-history.sh <base commit>" >&2; exit 2; }
base=$1
command -v jq > /dev/null || { echo "::error::check-drizzle-history.sh needs jq, and it isn't on PATH"; exit 2; }
git cat-file -e "$base^{commit}" 2> /dev/null || { echo "::error::check-drizzle-history.sh: $base isn't a commit here (fetch it first)"; exit 2; }
fail=0

changed=$(git diff --no-renames --name-status --diff-filter=MDT "$base" HEAD -- 'drizzle/*.sql') || exit 2
while IFS=$'\t' read -r status path; do
  [ -n "$path" ] || continue
  case "$status" in
    M) what="edits" ;;
    D) what="deletes (or renames)" ;;
    T) what="changes the file type of (e.g. to a symlink)" ;;
    *) what="changes" ;;
  esac
  echo "::error file=$path::this PR $what $path, a migration already on the base branch. A database that has applied it never sees the change: add a new migration instead."
  fail=1
done <<< "$changed"

if git cat-file -e "$base:drizzle/meta/_journal.json" 2> /dev/null; then
  old=$(git show "$base:drizzle/meta/_journal.json" | jq -c '.entries // []') || exit 2
  if ! new=$(git show "HEAD:drizzle/meta/_journal.json" 2> /dev/null \
      | jq -c '.entries // [] | if type == "array" then . else error("entries is not an array") end' 2> /dev/null); then
    echo "::error file=drizzle/meta/_journal.json::this PR's drizzle/meta/_journal.json is missing, doesn't parse, or has no entries array, so main's entries can't be compared (the 'Drizzle journal matches the migrations' step names the cause)."
    exit 1
  fi
  bad=$(jq -rn --argjson old "$old" --argjson new "$new" '
    [range(0; $old | length) as $i
     | select($new[$i] != $old[$i])
     | $old[$i].tag // "entry \($i)"] | join(", ")') || exit 2
  if [ -n "$bad" ]; then
    echo "::error file=drizzle/meta/_journal.json::this PR changes or removes journal entries already on the base branch ($bad). Existing entries stay as they are; add new ones after them."
    fail=1
  fi
fi

[ "$fail" -eq 0 ] && echo "drizzle history: no migration or journal entry on the base branch was changed"
exit "$fail"
