#!/usr/bin/env python3
"""Resolve and download the Firebase Messaging dependency closure.

FamilyShield has no Gradle, so nothing performs the dependency-resolution step
that the Android Gradle Plugin normally does. This script does exactly that one
job: walk the Maven POMs of the pinned roots, honour edge exclusions, download
the resulting AAR/JAR artifacts, and lay them out so `tools/build_apk.py` can
feed them to its existing javac/d8 pipeline.

Nothing here invents credentials. The Firebase project configuration
(google-services.json) is consumed separately by build_apk.py.

Layout written under .deps/firebase/ (cached between builds):

    jars/<artifact>-<version>.jar        classes.jar from AARs, or plain JARs
    res/<artifact>-<version>/            AAR res/ overlay directory
    manifests/<artifact>-<version>.xml   library AndroidManifest.xml
    jni/<abi>/*.so                       native libraries, if any
    closure.json                         resolved coordinates + source URLs

Usage:
    python tools/fetch_firebase_deps.py            # resolve, reuse cache
    python tools/fetch_firebase_deps.py --refresh  # re-download everything
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPS = ROOT / ".deps" / "firebase"

# Pinned deliberately: reproducible builds, and the version is recorded in
# closure.json so a reviewer can see exactly what shipped.
ROOTS = [
    ("com.google.firebase", "firebase-messaging", "26.0.0"),
]

REPOS = [
    "https://dl.google.com/dl/android/maven2",
    "https://repo1.maven.org/maven2",
]

POM_NS = "{http://maven.apache.org/POM/4.0.0}"

# Compile + runtime scopes end up in the APK. `provided` (android.jar-like) and
# `test` do not.
USED_SCOPES = {"compile", "runtime"}

UA = "FamilyShield-dep-resolver/1.0"


def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def _get(url: str, timeout: int = 60, attempts: int = 3) -> bytes | None:
    """GET a URL, returning None on a clean 404 (artifact simply absent)."""
    last = None
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        if attempt + 1 < attempts:
            time.sleep(1.5 * (attempt + 1))
    log(f"  ! failed to fetch {url} ({last})")
    return None


def _text(node, tag: str) -> str | None:
    child = node.find(POM_NS + tag)
    if child is None:
        child = node.find(tag)
    if child is None or child.text is None:
        return None
    return child.text.strip()


def _normalize_version(version: str) -> str:
    """Turn a Gradle/Maven rich version into a concrete version string.

    Gradle module metadata publishes ranges such as `[1.1.7]`, `[1.0,2.0)` or
    `1.1.7!!`. Maven repositories do not serve those as file paths, so take the
    first concrete token the range allows.
    """
    v = version.strip()
    if not v:
        return ""
    if v.startswith("[") or v.startswith("("):
        inner = v.lstrip("[(").rstrip("])")
        first = inner.split(",")[0].strip()
        return first
    return v.split("!!")[0].strip()


def _version_key(version: str) -> tuple:
    """Best-effort Maven-ish ordering so the newest request wins."""
    parts = re.split(r"[.\-]", version)
    key = []
    for part in parts:
        if part.isdigit():
            key.append((1, int(part), ""))
        else:
            key.append((0, 0, part))
    return tuple(key)


def _coord_path(group: str, artifact: str, version: str, ext: str) -> str:
    return (
        f"{group.replace('.', '/')}/{artifact}/{version}/"
        f"{artifact}-{version}.{ext}"
    )


def _pom_path(group: str, artifact: str, version: str) -> str:
    return _coord_path(group, artifact, version, "pom")


class Coord:
    __slots__ = ("group", "artifact", "version")

    def __init__(self, group: str, artifact: str, version: str):
        self.group = group
        self.artifact = artifact
        self.version = version

    def key(self) -> tuple:
        return (self.group, self.artifact)

    def label(self) -> str:
        return f"{self.group}:{self.artifact}:{self.version}"


def parse_dependencies(pom_bytes: bytes):
    """Return (deps, imported_bom_poms, properties).

    deps items: (group, artifact, version, type, scope, exclusions)
    """
    root = ET.fromstring(pom_bytes)
    deps = []

    prop_node = root.find(POM_NS + "properties")
    props = {}
    if prop_node is not None:
        for child in prop_node:
            tag = child.tag.replace(POM_NS, "")
            if child.text:
                props[tag] = child.text.strip()

    # <dependencyManagement> supplies versions to siblings without one.
    managed = {}
    dm = root.find(POM_NS + "dependencyManagement")
    if dm is not None:
        for d in dm.iter(POM_NS + "dependency"):
            g, a = _text(d, "groupId"), _text(d, "artifactId")
            v = _text(d, "version")
            if g and a and v:
                managed[(g, a)] = v

    # Only the POM's own <dependencies>, never <dependencyManagement> or plugin
    # dependencies. `root.iter` would walk the managed BOM entries too and pull
    # in every artifact a BOM merely pins (datastore/rx variants, etc.).
    deps_node = None
    for child in list(root):
        if child.tag in (POM_NS + "dependencies", "dependencies"):
            deps_node = child
            break
    for d in (list(deps_node) if deps_node is not None else []):
        if d.tag != POM_NS + "dependency":
            continue
        scope = _text(d, "scope") or "compile"
        if scope not in USED_SCOPES:
            continue
        # <optional>true</optional> is a pom-only convenience: Gradle never puts
        # those on the consumer's runtime classpath. Ignoring this flag pulls in
        # rxjava2/rxjava3/datastore-preferences-rxjava* and similar noise.
        if (_text(d, "optional") or "").lower() == "true":
            continue
        g = _text(d, "groupId")
        a = _text(d, "artifactId")
        v = _text(d, "version")
        if not g or not a:
            continue
        if v is None:
            v = managed.get((g, a))
        if v is None:
            continue
        # Resolve ${property} style versions where the POM told us the value.
        if v.startswith("${") and v.endswith("}"):
            v = props.get(v[2:-1], "")
            if not v:
                continue
        v = _normalize_version(v)
        if not v:
            continue
        typ = _text(d, "type") or "jar"
        if typ == "pom":
            continue
        excl = set()
        ex_node = d.find(POM_NS + "exclusions")
        if ex_node is not None:
            for e in ex_node.iter(POM_NS + "exclusion"):
                eg, ea = _text(e, "groupId"), _text(e, "artifactId")
                if eg and ea:
                    excl.add((eg, ea))
        deps.append((g, a, v, typ, scope, excl))
    return deps


def resolve() -> list[Coord]:
    """Walk the POM graph the way Gradle does for a compile+runtime classpath.

    Two rules matter and both are path sensitive:

    * newest requested version of an artifact wins (Gradle conflict resolution);
    * `<exclusions>` on a dependency edge cut only that edge's subtree, they do
      not remove the artifact from unrelated paths.

    The queue therefore carries the set of coordinates excluded so far, and a
    (coordinate, exclusions) pair is visited once.
    """
    pom_cache: dict[tuple, bytes | None] = {}
    selected: dict[tuple, str] = {}
    queue: list[tuple[Coord, frozenset]] = []
    visited: set[tuple] = set()

    for root in ROOTS:
        coord = Coord(*root)
        selected[coord.key()] = coord.version
        queue.append((coord, frozenset()))

    while queue:
        coord, exclusions = queue.pop(0)
        state = (coord.label(), exclusions)
        if state in visited:
            continue
        visited.add(state)

        pom = pom_cache.get(coord.key())
        if pom is None:
            raw = None
            for repo in REPOS:
                raw = _get(f"{repo}/{_pom_path(coord.group, coord.artifact, coord.version)}")
                if raw:
                    break
            pom_cache[coord.key()] = raw
            pom = raw
        if pom is None:
            log(f"  ? no POM for {coord.label()} (treating as leaf)")
            continue

        for g, a, v, typ, scope, edge_excl in parse_dependencies(pom):
            key = (g, a)
            if key in exclusions:
                continue  # cut by an exclusion declared further up this path
            chosen = selected.get(key)
            if chosen is None or _version_key(v) > _version_key(chosen):
                selected[key] = v
                chosen = v
            queue.append((Coord(g, a, chosen), exclusions | frozenset(edge_excl)))

    final = [Coord(g, a, v) for (g, a), v in selected.items()]
    final.sort(key=lambda c: (c.group, c.artifact))
    return final


def _extract_aar(aar_bytes: bytes, coord: Coord) -> str:
    """Split an AAR into jars/res/manifest/jni. Returns the relative jar path."""
    base = f"{coord.artifact}-{coord.version}"
    jar_out = DEPS / "jars" / f"{base}.jar"
    res_out = DEPS / "res" / base
    man_out = DEPS / "manifests" / f"{base}.xml"

    with zipfile.ZipFile(io.BytesIO(aar_bytes)) as zf:
        names = zf.namelist()
        if "classes.jar" in names:
            jar_out.parent.mkdir(parents=True, exist_ok=True)
            jar_out.write_bytes(zf.read("classes.jar"))
            jar = True
        else:
            jar = False

        if "AndroidManifest.xml" in names:
            man_out.parent.mkdir(parents=True, exist_ok=True)
            man_out.write_bytes(zf.read("AndroidManifest.xml"))

        for name in names:
            if name.startswith("res/") and not name.endswith("/"):
                dest = res_out / name[len("res/"):]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(zf.read(name))
            elif name.startswith("jni/") and not name.endswith("/"):
                tail = name[len("jni/"):]
                dest = DEPS / "jni" / tail
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(zf.read(name))

    if not jar:
        return ""
    return str(jar_out.relative_to(DEPS)).replace("\\", "/")


def download(coords: list[Coord], refresh: bool) -> dict:
    DEPS.mkdir(parents=True, exist_ok=True)
    for sub in ("jars", "res", "manifests", "jni"):
        (DEPS / sub).mkdir(parents=True, exist_ok=True)

    def _record(coord: Coord, source: str | None = None) -> dict:
        """Describe what actually landed on disk for this coordinate."""
        base = f"{coord.artifact}-{coord.version}"
        jar = DEPS / "jars" / f"{base}.jar"
        res = DEPS / "res" / base
        man = DEPS / "manifests" / f"{base}.xml"
        entry = {
            "coord": coord.label(),
            "jar": jar.relative_to(DEPS).as_posix() if jar.exists() else None,
            "res": res.relative_to(DEPS).as_posix() if res.exists() else None,
            "manifest": man.relative_to(DEPS).as_posix() if man.exists() else None,
        }
        if source:
            entry["source"] = source
        return entry

    resolved = []
    missing = []
    for coord in coords:
        base = f"{coord.artifact}-{coord.version}"
        jar_path = DEPS / "jars" / f"{base}.jar"
        man = DEPS / "manifests" / f"{base}.xml"
        if not refresh and (
            jar_path.exists() or man.exists() or (DEPS / "res" / base).exists()
        ):
            resolved.append(_record(coord))
            continue

        got = False
        for ext in ("aar", "jar"):
            for repo in REPOS:
                url = f"{repo}/{_coord_path(coord.group, coord.artifact, coord.version, ext)}"
                blob = _get(url)
                if not blob:
                    continue
                if ext == "aar":
                    _extract_aar(blob, coord)
                else:
                    jar_path.write_bytes(blob)
                log(f"  + {coord.label()} [{ext}]")
                resolved.append(_record(coord, url))
                got = True
                break
            if got:
                break
        if not got:
            missing.append(coord.label())
            log(f"  ! unavailable: {coord.label()}")

    manifest = {
        "roots": [f"{g}:{a}:{v}" for g, a, v in ROOTS],
        "repositories": REPOS,
        "artifacts": resolved,
        "missing": missing,
    }

    # Drop artifacts left over from an older closure so the build never links a
    # jar that resolution no longer selected.
    def _base(coord_label):
        _, artifact, version = coord_label.split(":")
        return f"{artifact}-{version}"

    keep_jars = {a["jar"] for a in resolved if a.get("jar")}
    for jar in (DEPS / "jars").glob("*.jar"):
        rel = jar.relative_to(DEPS).as_posix()
        if rel not in keep_jars:
            jar.unlink()
            log(f"  - pruned stale {rel}")

    keep = {_base(a["coord"]) for a in resolved}
    for path in (DEPS / "manifests").glob("*.xml"):
        if path.stem not in keep:
            path.unlink()
            log(f"  - pruned stale manifests/{path.name}")
    for path in (DEPS / "res").iterdir():
        if path.is_dir() and path.name not in keep:
            shutil.rmtree(path)
            log(f"  - pruned stale res/{path.name}")

    (DEPS / "closure.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="ignore the local cache")
    args = ap.parse_args()

    if os.environ.get("FS_SKIP_FIREBASE"):
        log("FS_SKIP_FIREBASE set - not resolving Firebase artifacts")
        return

    log("resolving Firebase dependency closure")
    coords = resolve()
    log(f"  {len(coords)} artifacts in closure")
    result = download(coords, args.refresh)

    jars = [a for a in result["artifacts"] if a.get("jar")]
    log(f"done: {len(jars)} jars, {len(result['missing'])} unavailable -> {DEPS}")
    if result["missing"]:
        log("  note: unavailable artifacts are listed in closure.json; the build")
        log("        will only fail if a missing class is actually referenced")


if __name__ == "__main__":
    main()
