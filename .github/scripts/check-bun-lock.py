#!/usr/bin/env python3
"""Check bun.lock against package.json, without installing anything.

Usage: check-bun-lock.py [bun.lock] [package.json]   (run from the repo root)

CI can't run `bun install --frozen-lockfile`: @hatch/space-sdk is a file:
tarball that exists only inside Muse. This checks what can be checked from
the two files alone:

- bun.lock parses (bun's text format allows trailing commas);
- the workspace's name, dependencies and devDependencies equal package.json's;
- every package key names the package its spec resolves (a nested key such as
  "prop-types/react-is" ends with the spec's name);
- a dependency package.json pins exactly resolves to that version;
- every registry package has a sha512 integrity;
- every package's dependencies, and the workspace's, resolve to a package in
  the lock.

It doesn't check integrity values against the registry: that needs the
network, and npm can't see the file: dependency anyway.
"""

import json
import re
import sys

EXACT = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")


def strip_trailing_commas(text: str) -> str:
    """Remove commas that come right before ] or }, outside strings."""
    out = []
    i, n = 0, len(text)
    in_string = False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            out.append(c)
        elif c == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "]}":
                i += 1
                continue
            out.append(c)
        else:
            out.append(c)
        i += 1
    return "".join(out)


def spec_name_version(spec: str) -> tuple[str, str]:
    """'@types/node@26.6.5' -> ('@types/node', '26.6.5')."""
    at = spec.rfind("@")
    if at <= 0:
        return spec, ""
    return spec[:at], spec[at + 1:]


def resolve(packages: dict, parent: str, dep: str) -> str | None:
    """The key bun would use for dep, seen from parent's key (nested first)."""
    parts = parent.split("/") if parent else []
    # Walk up the nesting: "a/b" looks for "a/b/dep", "a/dep", then "dep".
    # Scoped names take two path parts, so try every prefix.
    for cut in range(len(parts), -1, -1):
        prefix = "/".join(parts[:cut])
        key = f"{prefix}/{dep}" if prefix else dep
        if key in packages:
            return key
    return None


def main(argv: list[str]) -> int:
    lock_path = argv[0] if argv else "bun.lock"
    pkg_path = argv[1] if len(argv) > 1 else "package.json"
    errors: list[str] = []

    def err(msg: str) -> None:
        errors.append(msg)

    try:
        with open(lock_path, encoding="utf-8") as f:
            lock = json.loads(strip_trailing_commas(f.read()))
        with open(pkg_path, encoding="utf-8") as f:
            pkg = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"::error file={lock_path}::can't read or parse: {e}")
        return 1

    if not isinstance(lock, dict) or not isinstance(lock.get("packages"), dict):
        print(f"::error file={lock_path}::not a bun.lock: no packages map")
        return 1
    if not isinstance(lock.get("lockfileVersion"), int):
        err("lockfileVersion is missing or not a number")

    ws = (lock.get("workspaces") or {}).get("")
    packages = lock["packages"]
    if not isinstance(ws, dict):
        err('no root workspace ("workspaces": {"": ...})')
        ws = {}

    if ws.get("name") != pkg.get("name"):
        err(f"workspace name {ws.get('name')!r} != package.json name {pkg.get('name')!r}")
    for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        if (ws.get(field) or {}) != (pkg.get(field) or {}):
            err(f"workspace {field} differ from package.json's")

    for field in ("dependencies", "devDependencies"):
        for dep, want in (pkg.get(field) or {}).items():
            key = resolve(packages, "", dep)
            if key is None:
                err(f"package.json {field} {dep!r} has no package in the lock")
                continue
            _, got = spec_name_version(packages[key][0])
            if EXACT.match(want) and got != want:
                err(f"package.json pins {dep} {want}, the lock resolves {got}")

    for key, entry in packages.items():
        if not isinstance(entry, list) or not entry or not isinstance(entry[0], str):
            err(f"package {key!r}: entry isn't [spec, ...]")
            continue
        name, version = spec_name_version(entry[0])
        if key != name and not key.endswith("/" + name):
            err(f"package key {key!r} doesn't match its spec {entry[0]!r}")
        is_file = version.startswith("/") or version.startswith("file:")
        if not is_file and not (isinstance(entry[-1], str) and entry[-1].startswith("sha512-")):
            err(f"package {key!r}: no sha512 integrity")
        meta = next((e for e in entry[1:] if isinstance(e, dict)), {})
        for dep in (meta.get("dependencies") or {}):
            if resolve(packages, key, dep) is None:
                err(f"package {key!r} depends on {dep!r}, which isn't in the lock")

    for e in errors:
        print(f"::error file={lock_path}::{e}")
    print(f"{lock_path}: {len(packages)} packages, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
