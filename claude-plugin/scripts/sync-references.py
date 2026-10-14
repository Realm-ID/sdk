#!/usr/bin/env python3
"""Generate (or check) the skill's reference files from their public sources.

The `realmid-integration` skill ships copies of two sdk docs so a partner's agent can read
them offline. The copies are GENERATED, never hand-edited:

    docs/migrating-to-realmid.md -> references/migrating-to-realmid.md
    docs/error-reference.md      -> references/error-reference.md

Relative links in the source (`partner-integration-guide.md#...`, `../SPEC.md#...`) would
dangle inside the plugin, so they are rewritten to their public GitHub URL. Anchors within
the same page (`#heading`) are left alone.

Usage:
    sync-references.py            write the copies
    sync-references.py --check    exit 1 if any copy is stale or missing; exit 2 if it
                                  examined 0 files. Always prints how many it compared.
"""
import re
import sys
from pathlib import Path

SDK = Path(__file__).resolve().parents[2]
REF = SDK / "claude-plugin" / "skills" / "realmid-integration" / "references"
BASE = "https://github.com/Realm-ID/sdk/blob/main"
SOURCES = ["docs/migrating-to-realmid.md", "docs/error-reference.md"]

LINK = re.compile(r"\]\((?!https?://|#|mailto:)([^)\s]+)\)")


def _resolve(src_rel: str, target: str) -> str:
    base = (SDK / src_rel).parent
    path, _, frag = target.partition("#")
    resolved = (base / path).resolve().relative_to(SDK).as_posix()
    return f"{BASE}/{resolved}" + (f"#{frag}" if frag else "")


def render(src_rel: str) -> str:
    body = (SDK / src_rel).read_text()
    body = LINK.sub(lambda m: f"]({_resolve(src_rel, m.group(1))})", body)
    header = (
        f"<!-- GENERATED from {src_rel} by claude-plugin/scripts/sync-references.py. "
        "Do not edit; run the script. -->\n"
        f"<!-- Canonical: {BASE}/{src_rel} -->\n\n"
    )
    return header + body


def main() -> int:
    check = "--check" in sys.argv[1:]
    compared, bad = 0, []
    for src in SOURCES:
        want = render(src)
        dest = REF / Path(src).name
        compared += 1
        if check:
            if not dest.exists() or dest.read_text() != want:
                bad.append(str(dest.relative_to(SDK)))
        else:
            REF.mkdir(parents=True, exist_ok=True)
            dest.write_text(want)
    verb = "compared" if check else "wrote"
    print(f"claude-plugin references: {verb} {compared} file(s)")
    if compared == 0:
        print("::error::examined 0 files", file=sys.stderr)
        return 2
    if bad:
        for b in bad:
            print(f"::error::stale or missing: {b} (run claude-plugin/scripts/sync-references.py)",
                  file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
