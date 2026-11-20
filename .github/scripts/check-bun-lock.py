#!/usr/bin/env python3
"""Check bun.lock against package.json, without installing anything.

Usage: check-bun-lock.py [bun.lock] [package.json]   (run from the repo root)

CI can't run `bun install --frozen-lockfile`: @hatch/space-sdk is a file:
tarball that exists only inside Muse. This checks the lockfile's structure
against package.json instead, for the shape this repo's lock has: one root
workspace, with registry dependencies and file: dependencies on tarballs at
absolute paths (file:/path/x.tgz).

Checked:
- bun.lock parses (bun's text format allows trailing commas; a BOM is
  allowed), with no duplicate keys, and its lockfileVersion is one this check
  knows;
- the workspace's name and dependency maps equal package.json's;
- every package key's last package name ("@scope/name" kept whole; a nested
  key such as "prop-types/react-is" ends with it) equals its spec's name;
- a dependency package.json pins exactly resolves to that version, and a
  file: dependency resolves to that path;
- every registry entry is [spec, "", {...}, integrity] at an exact version
  (the default registry), and only the file: tarballs package.json names
  resolve to a path;
- every package has a sha512 integrity;
- every package's dependencies, and the workspace's, resolve to a package in
  the lock, looked up the way bun does: from the package's own nesting
  outward;
- every package is depended on by the workspace or another package.

Not modeled, so refused with an error saying so, and nothing else is
reported (extend this script if the repo starts using one): more than one
workspace; aliases and URL or git specs ("npm:", "github:", "git+",
"https:", "workspace:", "link:", and file: folders or relative paths);
package.json's overrides, resolutions, workspaces, catalog(s) and
patchedDependencies; and any top-level lock key other than lockfileVersion,
configVersion, workspaces, packages and trustedDependencies.

Not checked: integrity values against the registry (that needs the network,
and npm can't see the file: dependency), and whether the dependency ranges
inside package entries are satisfied by what they resolve to.
"""

from __future__ import annotations

import json
import re
import sys

EXACT = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")
KNOWN_LOCKFILE_VERSIONS = (1, 2)
DEP_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
# The lock's top-level keys this check understands; any other is refused.
# trustedDependencies only lists packages allowed to run install scripts.
KNOWN_LOCK_FIELDS = {"lockfileVersion", "configVersion", "workspaces", "packages", "trustedDependencies"}
# package.json fields that change resolution, which this check doesn't model.
UNMODELED_PACKAGE_JSON_FIELDS = ("overrides", "resolutions", "workspaces", "catalog", "catalogs",
                                 "patchedDependencies")


class LockError(Exception):
    """A problem that stops the check, with a message for the annotation."""


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
    """'@types/node@26.6.5' -> ('@types/node', '26.6.5'). The name ends at the
    first '@' after a scope's leading one: a version (a URL, say) can hold
    '@' too."""
    at = spec.find("@", 1)
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
    out = {}
    for k, v in pairs:
        if k in out:
            raise LockError(f"duplicate key {k!r}")
        out[k] = v
    return out


def load(path: str, lockfile: bool):
    try:
        with open(path, encoding="utf-8-sig") as f:
            text = f.read()
        if lockfile:
            text = strip_trailing_commas(text)
        return json.loads(text, object_pairs_hook=no_duplicate_keys)
    except LockError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise LockError(f"can't read or parse: {e}") from None


def dict_field(obj: dict, field: str) -> dict:
    value = obj.get(field) or {}
    return value if isinstance(value, dict) else {}


def main(argv: list[str]) -> int:
    lock_path = argv[0] if argv else "bun.lock"
    pkg_path = argv[1] if len(argv) > 1 else "package.json"
    errors: list[tuple[str, str]] = []
    refusals: list[tuple[str, str]] = []

    def err(msg: str, path: str = lock_path) -> None:
        errors.append((path, msg))

    def refuse(what: str, path: str = lock_path) -> None:
        """A shape this check doesn't model: reported alone, since the other
        checks would only misread it."""
        refusals.append((path, f"{what}, which this check doesn't model; extend check-bun-lock.py"))

    for path, lockfile in ((lock_path, True), (pkg_path, False)):
        try:
            data = load(path, lockfile)
        except LockError as e:
            print(f"::error file={path}::{e}")
            return 1
        if not isinstance(data, dict):
            print(f"::error file={path}::not a JSON object")
            return 1
        if lockfile:
            lock = data
        else:
            pkg = data
    if not isinstance(lock.get("packages"), dict):
        print(f"::error file={lock_path}::not a bun.lock: no packages map")
        return 1
    packages = lock["packages"]

    version = lock.get("lockfileVersion")
    if type(version) is not int or version not in KNOWN_LOCKFILE_VERSIONS:
        err(f"lockfileVersion {version!r} isn't one this check knows "
            f"({', '.join(map(str, KNOWN_LOCKFILE_VERSIONS))}); update check-bun-lock.py")

    # Shapes this check doesn't model: refuse them plainly instead of
    # guessing (a guess here was a false pass or a false fail).
    for field in sorted(set(lock) - KNOWN_LOCK_FIELDS):
        refuse(f"the lock has {field!r}")
    for field in UNMODELED_PACKAGE_JSON_FIELDS:
        if field in pkg:
            refuse(f"package.json has {field!r}", pkg_path)
    workspaces = lock.get("workspaces")
    ws = workspaces.get("") if isinstance(workspaces, dict) else None
    if not isinstance(ws, dict):
        err('no root workspace ("workspaces": {"": ...})')
        ws = {}
    if isinstance(workspaces, dict) and set(workspaces) - {""}:
        refuse("the lock has more than one workspace")

    file_keys = set()
    for field in DEP_FIELDS:
        for dep, want in dict_field(pkg, field).items():
            if not isinstance(want, str):
                err(f"{field} {dep!r} isn't a version string", pkg_path)
            elif want.startswith("file:/") and want.endswith((".tgz", ".tar.gz")):
                file_keys.add(dep)
            elif ":" in want:
                refuse(f"{field} {dep!r} uses {want!r} (an alias, or a URL, git, workspace, "
                       "link or file-folder spec)", pkg_path)

    if refusals:
        for path, msg in refusals + errors:
            print(f"::error file={path}::{msg}")
        print(f"{lock_path}: not checked: {len(refusals)} shapes this check doesn't model")
        return 1

    if ws.get("name") != pkg.get("name"):
        err(f"workspace name {ws.get('name')!r} != package.json name {pkg.get('name')!r}")
    for field in DEP_FIELDS:
        if dict_field(ws, field) != dict_field(pkg, field):
            err(f"workspace {field} differ from package.json's")

    def entry_ok(key: str) -> bool:
        e = packages.get(key)
        return isinstance(e, list) and bool(e) and isinstance(e[0], str)

    for field in DEP_FIELDS:
        if field == "peerDependencies":
            continue
        for dep, want in dict_field(pkg, field).items():
            if not isinstance(want, str):
                continue  # reported above
            key = resolve(packages, "", dep)
            if key is None:
                err(f"{field} {dep!r} has no package in the lock", pkg_path)
                continue
            if not entry_ok(key):
                continue  # reported below
            _, got = spec_name_version(packages[key][0])
            if dep in file_keys:
                # bun writes "file:/abs/x.tgz" as "name@/abs/x.tgz".
                path = want[len("file:"):]
                if got not in (path, want):
                    err(f"package.json has {dep} {want}, the lock resolves {got!r}")
            elif EXACT.match(want) and got != want:
                err(f"package.json pins {dep} {want}, the lock resolves {got}")

    referenced = set()
    for field in DEP_FIELDS:
        for dep in dict_field(ws, field):
            k = resolve(packages, "", dep)
            if k:
                referenced.add(k)

    for key, entry in packages.items():
        if not entry_ok(key):
            err(f"package {key!r}: entry isn't [spec, ...]")
            continue
        name, ver = spec_name_version(entry[0])
        if key_names(key)[-1] != name:
            err(f"package key {key!r} doesn't match its spec {entry[0]!r}")
        if ver.startswith("/"):
            # Only the file: tarballs package.json names, at the top level.
            if key not in file_keys:
                err(f"package {key!r} resolves to the path {ver!r}, but package.json "
                    "doesn't name it as a file: tarball")
            elif len(entry) != 3 or not isinstance(entry[1], dict):
                err(f"package {key!r}: a file: tarball entry isn't [spec, {{...}}, integrity]")
        elif ":" in ver:
            err(f"package {key!r} resolves to {ver!r}: URL, git, workspace and link "
                "specs aren't modeled; extend check-bun-lock.py")
        elif not EXACT.match(ver):
            err(f"package {key!r} resolves to {ver!r}, which isn't an exact version")
        elif len(entry) != 4 or entry[1] != "" or not isinstance(entry[2], dict):
            err(f"package {key!r}: a registry entry isn't [spec, \"\", {{...}}, integrity] "
                "(another registry or a tarball URL isn't modeled)")
        if not (isinstance(entry[-1], str) and entry[-1].startswith("sha512-")):
            err(f"package {key!r}: no sha512 integrity")
        meta = next((e for e in entry[1:] if isinstance(e, dict)), {})
        for field in ("dependencies", "optionalDependencies", "peerDependencies"):
            for dep in dict_field(meta, field):
                k = resolve(packages, key, dep)
                if k:
                    referenced.add(k)
                elif field == "dependencies":
                    err(f"package {key!r} depends on {dep!r}, which isn't in the lock")

    for key in packages:
        if key not in referenced:
            err(f"package {key!r} isn't depended on by the workspace or any package")

    for path, msg in errors:
        print(f"::error file={path}::{msg}")
    print(f"{lock_path}: {len(packages)} packages, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
