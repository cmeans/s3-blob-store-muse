#!/usr/bin/env python3
"""Check that relative links in Markdown files point at files in the repo.

Usage: check-md-links.py <file.md>...   (run from the repo root)

Checked: every inline link and image, `[text](target)`, wherever `](`
starts one: nested link text and badges (`[![alt](img.png)](page.md)`) are
read target by target. A target can be bare (one level of balanced
parentheses allowed) or in <angle brackets>, and can have a "title", 'title'
or (title). It is percent-decoded, its #fragment and ?query are dropped,
and it is looked up relative to the file's folder, or to the repo root when
it starts with `/` (as GitHub resolves it). A target outside the repo counts
as broken.

Not checked: links with a URL scheme (https:, mailto:, ...) or starting
with `//` or `#`, so the check needs no network; links inside fenced code
blocks and inline code (any backtick run, matched within one line; a line
that starts with a backtick run and has another backtick after it is
inline code, not a fence, as CommonMark reads it); reference-style link
definitions; HTML links (`<a href>`, `<img src>`).

Read as text, so a link-shaped string there is checked too: indented code
blocks, fences inside blockquotes, HTML comments, and escaped brackets.
A code span that runs across lines is checked line by line, so a link in
it is reported. And a fence-shaped line inside an HTML comment or HTML
block, or a list item's fence that the item's end closes, is read as a
fence, which hides the links after it (#46).
"""

import re
import sys
from pathlib import Path
from urllib.parse import unquote

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
# A code span: a backtick run, then the same-length run that closes it.
INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
TITLE = re.compile(r"\s+(?:\"[^\"]*\"|'[^']*'|\([^()]*\))")


def targets(line: str) -> list[str]:
    """The target of each `](...)` on the line."""
    found = []
    for m in re.finditer(r"\]\(", line):
        i = m.end()
        while i < len(line) and line[i] in " \t":
            i += 1
        if line.startswith("<", i):
            end = line.find(">", i)
            if end == -1:
                continue
            target, i = line[i + 1:end], end + 1
        else:
            start, depth = i, 0
            while i < len(line) and not line[i].isspace():
                if line[i] == "(":
                    depth += 1
                elif line[i] == ")":
                    if depth == 0:
                        break
                    depth -= 1
                i += 1
            target = line[start:i]
        t = TITLE.match(line, i)
        if t:
            i = t.end()
        while i < len(line) and line[i] in " \t":
            i += 1
        if line.startswith(")", i) and target:
            found.append(target)
    return found


def check(path: Path, root: Path) -> list[str]:
    errors = []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return [f"{path}: can't read: {e}"]
    fence = None  # the opening fence's character and length, while inside one
    # CommonMark's line endings only: str.splitlines() also splits on form
    # feed, U+2028, NEL and others, which could fake a fence line.
    for n, line in enumerate(re.split(r"\r\n|\r|\n", text), 1):
        m = FENCE.match(line)
        if fence is None:
            # CommonMark: a backtick fence's info string can't contain a
            # backtick, so "```x``` is inline code." is a paragraph, not a
            # fence that would hide every later link. (A ~~~ fence's can.)
            if m and m.group(1)[0] == "`" and "`" in line[m.end():]:
                m = None
            if m:
                fence = (m.group(1)[0], len(m.group(1)))
                continue
        else:
            # CommonMark: closed by the same character, at least as long,
            # with nothing else on the line.
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1] \
                    and not line[m.end():].strip():
                fence = None
            continue
        for target in targets(INLINE_CODE.sub("", line)):
            if SCHEME.match(target) or target.startswith(("//", "#")):
                continue
            rel = unquote(re.split(r"[#?]", target, maxsplit=1)[0])
            if not rel:
                continue
            base = root if rel.startswith("/") else path.parent
            resolved = (base / rel.lstrip("/")).resolve()
            if not resolved.is_relative_to(root):
                errors.append(f"{path}:{n}: link leaves the repo: {target}")
            elif not resolved.exists():
                errors.append(f"{path}:{n}: broken link: {target}")
    return errors


def main(argv: list[str]) -> int:
    if not argv:
        print("no files given", file=sys.stderr)
        return 2
    root = Path.cwd().resolve()
    errors = [e for f in argv for e in check(Path(f), root)]
    for e in errors:
        print(e)
    print(f"{len(argv)} files, {len(errors)} broken links")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
