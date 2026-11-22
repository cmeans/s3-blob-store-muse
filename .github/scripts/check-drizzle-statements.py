#!/usr/bin/env python3
"""Each chunk of each drizzle/*.sql migration holds at most one statement (#40).

Usage: check-drizzle-statements.py <drizzle folder>   (exit 0 ok, 1 problems, 2 usage)

drizzle-orm's migrator (0.45.2, readMigrationFiles) splits every migration on
"--> statement-breakpoint", whatever the journal's `breakpoints` flag says,
and runs each chunk with one session.run(). bun:sqlite's run executes only
the chunk's first statement, so a second statement in the same chunk is
dropped without an error, and the schema test then reports a column as
missing though the .sql plainly has it. This names the file and the line
where the dropped statement starts, and says to add a breakpoint.

Statements are counted by top-level semicolons, skipping:
- -- line comments and /* block */ comments;
- '...', "...", `...` and [...] quoted text ('' and "" escapes included);
- a trigger's body: in a CREATE TRIGGER statement, the semicolons between
  BEGIN and its END belong to the trigger.
A chunk with only whitespace and comments counts as no statement.
"""

import re
import sys
from pathlib import Path

BREAKPOINT = "--> statement-breakpoint"
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def statements(chunk: str) -> list[int]:
    """Offsets where each statement in the chunk starts."""
    starts: list[int] = []
    i, n = 0, len(chunk)
    current_start = None  # offset of the statement being read
    words: list[str] = []  # upper-cased keywords of the current statement
    depth = 0  # BEGIN ... END nesting, inside a CREATE TRIGGER
    while i < n:
        c = chunk[i]
        if chunk.startswith("--", i):
            j = chunk.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if chunk.startswith("/*", i):
            j = chunk.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if c.isspace():
            i += 1
            continue
        if current_start is None:
            current_start = i
            starts.append(i)
        if c in "'\"`[":
            close = "]" if c == "[" else c
            j = i + 1
            while j < n:
                if chunk[j] == close:
                    if close != "]" and j + 1 < n and chunk[j + 1] == close:
                        j += 2  # '' or "" escape
                        continue
                    break
                j += 1
            i = j + 1
            continue
        m = WORD.match(chunk, i)
        if m:
            w = m.group(0).upper()
            words.append(w)
            if words[:1] == ["CREATE"] and "TRIGGER" in words[:4]:
                if w in ("BEGIN", "CASE"):
                    depth += 1
                elif w == "END" and depth:
                    depth -= 1
            i = m.end()
            continue
        if c == ";" and depth == 0:
            current_start, words = None, []
        i += 1
    return starts


def check(folder: Path) -> list[str]:
    errors = []
    files = sorted(folder.glob("*.sql"))
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            errors.append(f"::error file={path}::{path}: can't read it ({e})")
            continue
        offset = 0
        for chunk in text.split(BREAKPOINT):
            starts = statements(chunk)
            for extra in starts[1:]:
                line = text.count("\n", 0, offset + extra) + 1
                errors.append(
                    f"::error file={path},line={line}::{path}:{line}: a second statement in one chunk:"
                    f" drizzle's migrator runs only the first, so this one is dropped without an error."
                    f" Put '{BREAKPOINT}' on the line before it."
                )
            offset += len(chunk) + len(BREAKPOINT)
    if not errors:
        print(f"drizzle migrations: {len(files)} files, one statement per chunk")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 1 or not Path(argv[0]).is_dir():
        print("usage: check-drizzle-statements.py <drizzle folder>", file=sys.stderr)
        return 2
    errors = check(Path(argv[0]))
    for e in errors:
        print(e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
