#!/usr/bin/env python3
"""Doc-claim check: docs/claims.yaml <-> `Claim: <id>` lines in docs/**/*.md.

Fails when
  * a `doc` anchor (path#slug, GitHub slug rules) in claims.yaml no longer resolves,
  * a `Claim:` line in the docs has no claims.yaml entry, or the reverse,
  * a `Claim:` line sits under a heading its entry does not list in `doc`,
  * an entry is malformed (no statement, no pinned_by and not an absence).
Prints how many claims, anchors and Claim: lines it examined; examining 0 is a failure.

The issuer vendors claims.yaml (issuer/scripts/revendor-claims.sh) and proves every
`pinned_by` test exists; this script only guards the doc side, so it needs no issuer.

Usage: scripts/check-doc-claims.py [--list]   (--list prints each Claim: line's heading slug)
No third-party imports on purpose: CI and the pre-push hook run it bare.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
CLAIM_RE = re.compile(r"^Claim: `([a-z0-9][a-z0-9-]*)`\s*$")
HEAD_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def slugify(text):
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # [t](url) -> t
    text = text.lower()
    out = []
    for ch in text:
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        elif ch.isspace():
            out.append("-")
    return "".join(out)


def scan_docs():
    """Return (anchors, claim_lines): anchors[relpath] = set(slug);
    claim_lines = [(id, relpath, slug-of-nearest-heading, lineno)]."""
    anchors, claim_lines = {}, []
    for dp, _, files in os.walk(DOCS):
        for fn in sorted(files):
            if not fn.endswith(".md"):
                continue
            path = os.path.join(dp, fn)
            rel = os.path.relpath(path, ROOT)
            seen, slugs, cur, fence = {}, set(), None, False
            with open(path, encoding="utf-8") as fh:
                for n, line in enumerate(fh, 1):
                    if line.lstrip().startswith("```"):
                        fence = not fence
                        continue
                    if fence:
                        continue
                    m = HEAD_RE.match(line)
                    if m:
                        s = slugify(m.group(2))
                        k = seen.get(s, 0)
                        seen[s] = k + 1
                        cur = s if k == 0 else "%s-%d" % (s, k)
                        slugs.add(cur)
                        continue
                    c = CLAIM_RE.match(line)
                    if c:
                        claim_lines.append((c.group(1), rel, cur, n))
            anchors[rel] = slugs
    return anchors, claim_lines


def parse_claims(path):
    """Minimal parser for the restricted claims.yaml shape (see the file header)."""
    entries, cur, key = [], None, None
    with open(path, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if line.startswith("claims:"):
                continue
            m = re.match(r"^  - (\w+):\s*(.*)$", line)
            if m:
                cur = {}
                entries.append(cur)
                key, val = m.group(1), m.group(2)
            else:
                m = re.match(r"^    (\w+):\s*(.*)$", line)
                if m and cur is not None:
                    key, val = m.group(1), m.group(2)
                else:
                    m = re.match(r"^      - (.*)$", line)
                    if m and cur is not None and key:
                        cur.setdefault(key, []).append(unquote(m.group(1)))
                        continue
                    raise SystemExit("claims.yaml:%d: cannot parse %r" % (n, line))
            if val == "":
                cur[key] = []
            else:
                cur[key] = unquote(val)
    return entries


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v


def main():
    anchors, claim_lines = scan_docs()
    if "--list" in sys.argv:
        for cid, rel, slug, n in claim_lines:
            print("%s\t%s#%s" % (cid, rel, slug))
        return 0
    entries = parse_claims(os.path.join(DOCS, "claims.yaml"))
    errors, ids, n_anchors = [], set(), 0
    for e in entries:
        cid = e.get("id", "?")
        if cid in ids:
            errors.append("duplicate claim id %s" % cid)
        ids.add(cid)
        if not e.get("statement"):
            errors.append("%s: no statement" % cid)
        if not e.get("pinned_by"):
            errors.append("%s: no pinned_by" % cid)
        if e.get("kind") == "absence" and not e.get("note"):
            errors.append("%s: kind absence needs a note" % cid)
        docs = e.get("doc") or []
        if not docs:
            errors.append("%s: no doc anchor" % cid)
        for d in docs:
            n_anchors += 1
            path, _, slug = d.partition("#")
            if path not in anchors:
                errors.append("%s: doc file %s not found" % (cid, path))
            elif slug not in anchors[path]:
                errors.append("%s: anchor %s does not resolve" % (cid, d))
    doc_ids = {c[0] for c in claim_lines}
    for cid, rel, slug, n in claim_lines:
        e = next((x for x in entries if x.get("id") == cid), None)
        if e is None:
            errors.append("%s:%d: Claim %s has no entry in docs/claims.yaml" % (rel, n, cid))
        elif "%s#%s" % (rel, slug) not in (e.get("doc") or []):
            errors.append("%s:%d: Claim %s sits under #%s, which its entry does not list" % (rel, n, cid, slug))
    for cid in sorted(ids - doc_ids):
        errors.append("claims.yaml entry %s has no `Claim:` line in the docs" % cid)
    print("examined %d claims, %d doc anchors, %d Claim: lines" % (len(entries), n_anchors, len(claim_lines)))
    if not entries or not n_anchors or not claim_lines:
        errors.append("examined nothing: a check that sees 0 items proves nothing")
    for err in errors:
        print("FAIL: " + err)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
