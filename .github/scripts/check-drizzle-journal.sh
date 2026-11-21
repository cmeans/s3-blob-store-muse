#!/bin/bash
# drizzle/meta/_journal.json agrees with drizzle/*.sql (issue #19).
#
# drizzle-orm's migrator applies what the journal lists, in its order, and
# skips the rest without a word:
# - a .sql file with no journal entry is never applied;
# - an entry whose `when` isn't later than the last applied one is skipped
#   on an existing database but applied on a fresh one, so the two end up
#   with different schemas.
# A journal tag with no .sql file, or a journal that doesn't parse, fails
# the migrator loudly; this names those too.
#
# Checks: the journal parses and has an entries array; its tags and the
# .sql files are the same set; idx runs 0..n-1 in order; `when` never
# decreases, and is strictly later than the entry before from the third
# entry on (0001 and 0002 share a `when` in the live Space's journal; later
# ones must not).
#
# Usage: check-drizzle-journal.sh <drizzle folder>. Exit 0 when it agrees,
# 1 with an ::error line for each problem, 2 on a usage error. Needs jq.
set -uo pipefail

[ $# -eq 1 ] || { echo "usage: check-drizzle-journal.sh <drizzle folder>" >&2; exit 2; }
d=$1
j=$d/meta/_journal.json
fail=0
err() { echo "::error file=$1::$2"; fail=1; }

if ! jq -e '.entries | type == "array"' "$j" > /dev/null 2>&1; then
  err "$j" "$j is missing, isn't JSON, or has no entries array"
  exit 1
fi

# Tags and .sql files: the same set.
shopt -s nullglob
sql=()
for f in "$d"/*.sql; do sql+=("$(basename "$f" .sql)"); done
mapfile -t tags < <(jq -r '.entries[].tag' "$j")
while read -r t; do
  [ -n "$t" ] && err "$d/$t.sql" "$t.sql has no journal entry, so the migrator never applies it: add it to $j"
done < <(comm -13 <(printf '%s\n' "${tags[@]}" | sort -u) <(printf '%s\n' "${sql[@]}" | sort -u))
while read -r t; do
  [ -n "$t" ] && err "$j" "journal entry $t has no $t.sql in $d"
done < <(comm -23 <(printf '%s\n' "${tags[@]}" | sort -u) <(printf '%s\n' "${sql[@]}" | sort -u))
dups=$(printf '%s\n' "${tags[@]}" | sort | uniq -d)
[ -z "$dups" ] || err "$j" "journal tags listed more than once: $(echo "$dups" | paste -sd, -)"

# idx: 0..n-1, in order.
jq -e '[.entries[].idx] == [range(0; .entries | length)]' "$j" > /dev/null \
  || err "$j" "journal idx values aren't 0..n-1 in order: $(jq -c '[.entries[].idx]' "$j")"

# when: a number on every entry, never decreasing, strictly later from the
# third entry on.
jq -e 'all(.entries[]; .when | type == "number")' "$j" > /dev/null \
  || err "$j" "a journal entry's when is missing or not a number"
while read -r line; do
  [ -n "$line" ] && err "$j" "$line"
done < <(jq -r '.entries as $e | range(1; $e | length) as $i
  | select(($e[$i].when | type) == "number" and ($e[$i-1].when | type) == "number")
  | select($e[$i].when < $e[$i-1].when or ($i >= 2 and $e[$i].when == $e[$i-1].when))
  | "journal entry \($e[$i].tag)'"'"'s when (\($e[$i].when)) is not later than \($e[$i-1].tag)'"'"'s (\($e[$i-1].when)): the migrator would skip it on an existing database"' "$j")

[ "$fail" -eq 0 ] && echo "drizzle journal: ${#tags[@]} entries, ${#sql[@]} .sql files, in order"
exit "$fail"
