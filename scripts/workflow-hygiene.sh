#!/usr/bin/env bash
# Local mirror of .github/workflows/workflow-hygiene.yml's
# "third-party actions are SHA-pinned" job.
#
# WHY THIS EXISTS. `make check` mirrors `ci.yml` and ONLY `ci.yml` — that is
# stated in the Makefile header and it was true. But `workflow-hygiene.yml` is
# a SECOND required workflow that fails a push, and nothing local ran it: a CI
# failure audit over the last 60 runs on this repo (2026-09-18) found exactly
# one failure class that no local gate could have caught, and this was it
# (`actions/checkout@v7` / `actions/setup-node@v5` left on mutable tags).
# "make check mirrors ci.yml" is an accurate description of a gap, not a
# defence of one.
#
# WHY NOT THE WORKFLOW'S OWN `grep -P`. macOS `/usr/bin/grep` has no `-P`, so
# copying the CI command verbatim would fail as a BROKEN CHECKER on the machine
# this is written for — and a checker that errors reads, at a glance, exactly
# like a checker that found something. The rule is re-implemented in python3
# (already required by `make check` for taxonomy-parity.py) with the same
# semantics, and the two are held together by the fact that BOTH sides carry a
# self-test that plants a violation and requires it to be caught. Proving each
# side FIRES is a stronger tie than proving the two command strings match: a
# pattern that matches nothing passes a string-equality check happily.
#
# THE RULE (identical to the workflow's):
#   `uses: owner/repo@ref` must have a 40-char hex SHA as its ref.
#   Local refs (`./…`) are excluded.
#   `Just-Git-Dev/reusable-workflows/...@vX.Y.Z` is excluded ON PURPOSE —
#   semver there tracks the workflow's INPUT CONTRACT.
#
# Usage:
#   scripts/workflow-hygiene.sh              # check .github/workflows
#   scripts/workflow-hygiene.sh --self-test  # prove the check fires, then exit
#
# Exit 0 = every third-party action is SHA-pinned (or the self-test passed),
# 1 = an unpinned ref was found (or the self-test did NOT fire),
# 2 = the checker could not run (no python3, no workflows dir).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS="$REPO_ROOT/.github/workflows"

if ! command -v python3 >/dev/null 2>&1; then
  echo "::error::workflow-hygiene.sh: python3 not found — this is a broken checker, not a finding" >&2
  exit 2
fi

scan() {
  # $1 = directory to scan. Prints one "file:line: text" per violation.
  python3 - "$1" <<'PY'
import os
import re
import sys

root = sys.argv[1]
if not os.path.isdir(root):
    print(f"::error::workflow-hygiene.sh: {root} does not exist", file=sys.stderr)
    sys.exit(2)

# `uses: <owner>/<repo>...@<ref>` where <ref> is NOT a 40-char hex sha.
# `[^./]` on the first character excludes local (`./…`) refs, exactly as the
# workflow's pattern does.
USES = re.compile(r'^\s*(?:-\s*)?uses:\s*([^./\s][^@\s]*)@(\S+)')
SHA = re.compile(r'^[0-9a-f]{40}$')
EXCLUDE = "Just-Git-Dev/reusable-workflows/"

bad = 0
for name in sorted(os.listdir(root)):
    if not name.endswith((".yml", ".yaml")):
        continue
    path = os.path.join(root, name)
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            m = USES.match(line)
            if not m:
                continue
            action, ref = m.group(1), m.group(2)
            if action.startswith(EXCLUDE):
                continue
            if SHA.match(ref):
                continue
            print(f"{path}:{n}: {line.rstrip()}")
            bad += 1
sys.exit(1 if bad else 0)
PY
}

if [ "${1:-}" = "--self-test" ]; then
  # A gate that greps must be SHOWN to fire. A narrowed or broken pattern is
  # otherwise indistinguishable from a clean tree — which is the failure mode
  # this repo's own checker-tests rule exists for.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/workflows"

  # 1. a violation must be CAUGHT.
  printf 'jobs:\n  x:\n    steps:\n      - uses: actions/checkout@v7\n' > "$tmp/workflows/bad.yml"
  if scan "$tmp/workflows" >/dev/null 2>&1; then
    echo "::error::self-test: an unpinned 'actions/checkout@v7' was NOT caught — the check is inert" >&2
    exit 1
  fi

  # 2. a clean tree must PASS. Without this, a check that fails on everything
  #    would satisfy the assertion above while being useless.
  rm -f "$tmp/workflows/bad.yml"
  {
    printf 'jobs:\n  x:\n    steps:\n'
    printf '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n'
    printf '      - uses: ./.github/actions/local\n'
    printf '      - uses: Just-Git-Dev/reusable-workflows/.github/workflows/x.yml@v1.2.3\n'
  } > "$tmp/workflows/good.yml"
  if ! scan "$tmp/workflows" >/dev/null 2>&1; then
    echo "::error::self-test: a correctly pinned workflow was REJECTED — the check is over-broad" >&2
    scan "$tmp/workflows" >&2
    exit 1
  fi

  echo "workflow-hygiene self-test: the pin check fires on a violation and passes a clean tree."
  exit 0
fi

out="$(scan "$WORKFLOWS")"
rc=$?
if [ "$rc" -eq 2 ]; then
  exit 2
fi
if [ "$rc" -ne 0 ]; then
  echo "$out"
  echo "::error::Third-party actions must be pinned to a full commit SHA." >&2
  echo "Pin each ref above to the action's 40-char commit SHA and keep the tag as a trailing comment," >&2
  echo "e.g.  uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" >&2
  exit 1
fi
echo "All third-party action references are SHA-pinned."
