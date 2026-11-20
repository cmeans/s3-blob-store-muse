#!/usr/bin/env python3
"""Check that relative links in Markdown files point at files in the repo.

Usage: check-md-links.py <file.md>...   (run from the repo root)

Checked: inline links and images, `[text](target)`. A target is looked up
relative to the file's folder, or to the repo root when it starts with `/`
(as GitHub resolves it), after its #fragment and ?query are dropped. A target
outside the repo counts as broken.

Not checked: links with a URL scheme (https:, mailto:, ...) or starting
with `//` or `#`, so the check needs no network; links inside fenced code
blocks and inline code; reference-style link definitions.
"""

import re
import sys
from pathlib import Path

LINK = re.compile(r"!?\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+\"[^\"]*\")?\s*\)")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
INLINE_CODE = re.compile(r"`[^`]*`")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def check(path: Path, root: Path) -> list[str]:
    errors = []
    fence = None  # the opening fence's character and length, while inside one
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        m = FENCE.match(line)
        if fence is None:
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
        for angle, bare in LINK.findall(INLINE_CODE.sub("", line)):
            target = angle or bare
            if not target or SCHEME.match(target) or target.startswith(("//", "#")):
                continue
            rel = re.split(r"[#?]", target, maxsplit=1)[0]
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
