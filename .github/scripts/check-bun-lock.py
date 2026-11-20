#!/usr/bin/env python3
"""Check bun.lock against package.json, without installing anything.

Usage: check-bun-lock.py [bun.lock] [package.json]   (run from the repo root)

CI can't run `bun install --frozen-lockfile`: @hatch/space-sdk is a file:
tarball that exists only inside Muse. This checks what can be checked from
the two files alone:

- bun.lock parses (bun's text format allows trailing commas), and its
  lockfileVersion is one this script knows;
- the workspace's name and dependency maps equal package.json's;
- every package key names the package its spec resolves: the key's last
  package name (a nested key such as "prop-types/react-is" ends with it)
  equals the spec's name, unless the workspace declares that name with an
  alias or URL spec (one containing ":", such as "npm:other@1");
- a dependency package.json pins exactly resolves to that version;
- every registry package has a sha512 integrity;
- every package's dependencies, and the workspace's, resolve to a package in
  the lock, looked up the way bun does: from the package's own nesting
  outward, with scoped names ("@scope/name") kept whole.

Not checked: integrity values against the registry (that needs the network,
and npm can't see the file: dependency), and whether the dependency ranges
inside package entries are satisfied by what they resolve to.
"""

import json
import re
import sys

EXACT = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")
KNOWN_LOCKFILE_VERSIONS = (1, 2)
NO_INTEGRITY = ("/", "file:", "workspace:", "link:")


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


def key_names(key: str) -> list[str]:
    """'a/@s/b/c' -> ['a', '@s/b', 'c']: package names, scoped ones kept whole."""
    parts, names, i = key.split("/"), [], 0
    while i < len(parts):
        if parts[i].startswith("@") and i + 1 < len(parts):
            names.append(parts[i] + "/" + parts[i + 1])
            i += 2
        else:
            names.append(parts[i])
            i += 1
    return names


def resolve(packages: dict, parent: str, dep: str) -> str | None:
    """The key bun uses for dep, seen from parent's key: "a/b" looks for
    "a/b/dep", then "a/dep", then "dep"."""
    names = key_names(parent) if parent else []
    for cut in range(len(names), -1, -1):
        prefix = "/".join(names[:cut])
        key = f"{prefix}/{dep}" if prefix else dep
        if key in packages:
            return key
    return None


def no_duplicate_keys(pairs: list) -> dict:
    """json object hook: a repeated key is an error, not a silent last-wins."""
    out = {}
    for k, v in pairs:
        if k in out:
            raise json.JSONDecodeError(f"duplicate key {k!r}", "", 0)
        out[k] = v
    return out


def load_json(path: str, text_filter=None):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return json.loads(text_filter(text) if text_filter else text,
                      object_pairs_hook=no_duplicate_keys)


def main(argv: list[str]) -> int:
    lock_path = argv[0] if argv else "bun.lock"
    pkg_path = argv[1] if len(argv) > 1 else "package.json"
    errors: list[str] = []

    def err(msg: str) -> None:
        errors.append(msg)

    try:
        lock = load_json(lock_path, strip_trailing_commas)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"::error file={lock_path}::can't read or parse: {e}")
        return 1
    try:
        pkg = load_json(pkg_path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"::error file={pkg_path}::can't read or parse: {e}")
        return 1
    if not isinstance(pkg, dict):
        print(f"::error file={pkg_path}::not a JSON object")
        return 1
    if not isinstance(lock, dict) or not isinstance(lock.get("packages"), dict):
        print(f"::error file={lock_path}::not a bun.lock: no packages map")
        return 1

    version = lock.get("lockfileVersion")
    if isinstance(version, bool) or version not in KNOWN_LOCKFILE_VERSIONS:
        err(f"lockfileVersion {version!r} isn't one this check knows "
            f"({', '.join(map(str, KNOWN_LOCKFILE_VERSIONS))}); update check-bun-lock.py")

    workspaces = lock.get("workspaces")
    ws = workspaces.get("") if isinstance(workspaces, dict) else None
    packages = lock["packages"]
    if not isinstance(ws, dict):
        err('no root workspace ("workspaces": {"": ...})')
        ws = {}

    if ws.get("name") != pkg.get("name"):
        err(f"workspace name {ws.get('name')!r} != package.json name {pkg.get('name')!r}")
    for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        if (ws.get(field) or {}) != (pkg.get(field) or {}):
            err(f"workspace {field} differ from package.json's")

    def entry_ok(key: str) -> bool:
        e = packages.get(key)
        return isinstance(e, list) and bool(e) and isinstance(e[0], str)

    for field in ("dependencies", "devDependencies"):
        deps = pkg.get(field) or {}
        if not isinstance(deps, dict):
            err(f"package.json {field} isn't an object")
            continue
        for dep, want in deps.items():
            key = resolve(packages, "", dep)
            if key is None:
                err(f"package.json {field} {dep!r} has no package in the lock")
                continue
            if not entry_ok(key):
                continue  # reported in the package loop below
            _, got = spec_name_version(packages[key][0])
            if isinstance(want, str) and EXACT.match(want) and got != want:
                err(f"package.json pins {dep} {want}, the lock resolves {got}")

    # Names a workspace declares with an alias or URL spec ("npm:", "github:",
    # a tarball URL, "workspace:"): their keys don't have to match the spec.
    declared = {}
    for w in (workspaces or {}).values() if isinstance(workspaces, dict) else ():
        if isinstance(w, dict):
            for f in ("dependencies", "devDependencies", "optionalDependencies"):
                for d, s in (w.get(f) or {}).items():
                    declared[d] = s

    # Every package must be reachable: depended on by the workspace or by
    # another package (any dependency map). An orphan means a hand edit.
    referenced = set()
    all_ws = [w for w in workspaces.values() if isinstance(w, dict)] if isinstance(workspaces, dict) else []
    for w in all_ws:
        for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            wdeps = w.get(field) or {}
            for dep in (wdeps if isinstance(wdeps, dict) else {}):
                k = resolve(packages, "", dep)
                if k:
                    referenced.add(k)
    for key in packages:
        if not entry_ok(key):
            continue
        meta = next((e for e in packages[key][1:] if isinstance(e, dict)), {})
        for field in ("dependencies", "optionalDependencies", "peerDependencies"):
            fdeps = meta.get(field) or {}
            for dep in (fdeps if isinstance(fdeps, dict) else {}):
                k = resolve(packages, key, dep)
                if k:
                    referenced.add(k)
    for key in packages:
        if key not in referenced:
            err(f"package {key!r} isn't depended on by the workspace or any package")

    for key, entry in packages.items():
        if not entry_ok(key):
            err(f"package {key!r}: entry isn't [spec, ...]")
            continue
        name, ver = spec_name_version(entry[0])
        names = key_names(key)
        last = names[-1]
        # Only a top-level key can be a workspace's aliased dependency.
        aliased = len(names) == 1 and ":" in str(declared.get(last, ""))
        if last != name and not aliased:
            err(f"package key {key!r} doesn't match its spec {entry[0]!r}")
        if not ver.startswith(NO_INTEGRITY) and ":" not in str(declared.get(last, "")):
            if not (isinstance(entry[-1], str) and entry[-1].startswith("sha512-")):
                err(f"package {key!r}: no sha512 integrity")
        meta = next((e for e in entry[1:] if isinstance(e, dict)), {})
        deps = meta.get("dependencies") or {}
        if not isinstance(deps, dict):
            err(f"package {key!r}: dependencies isn't an object")
            continue
        for dep in deps:
            if resolve(packages, key, dep) is None:
                err(f"package {key!r} depends on {dep!r}, which isn't in the lock")

    for e in errors:
        print(f"::error file={lock_path}::{e}")
    print(f"{lock_path}: {len(packages)} packages, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
