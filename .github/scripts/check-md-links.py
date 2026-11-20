#!/usr/bin/env python3
"""Check that relative links in Markdown files point at files in the repo.

Usage: check-md-links.py <file.md>...

Only relative links are checked: http(s), mailto and in-page (#...) links
are skipped, so the check needs no network. Links inside fenced code blocks
and inline code are ignored. A link's #fragment is dropped before the target
is looked up.
"""

import re
import sys
from pathlib import Path

LINK = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
FENCE = re.compile(r"^\s*(```|~~~)")
INLINE_CODE = re.compile(r"`[^`]*`")
SKIP = ("http://", "https://", "mailto:", "#")


def check(path: Path) -> list[str]:
    errors = []
    in_fence = False
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for target in LINK.findall(INLINE_CODE.sub("", line)):
            if target.startswith(SKIP):
                continue
            rel = target.split("#", 1)[0]
            if not rel:
                continue
            if not (path.parent / rel).exists():
                errors.append(f"{path}:{n}: broken link: {target}")
    return errors


def main(argv: list[str]) -> int:
    if not argv:
        print("no files given", file=sys.stderr)
        return 2
    errors = [e for f in argv for e in check(Path(f))]
    for e in errors:
        print(e)
    print(f"{len(argv)} files, {len(errors)} broken links")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
