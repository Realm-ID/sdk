#!/usr/bin/env bash
# Assert scripts/preflight-check.sh and .github/workflows/ci.yml still invoke
# each gate with the SAME command string.
#
# WHY THIS EXISTS. `make check`'s go/ts gates are not all thin wrappers around
# a script — CI's `gofmt`, "Build + vet", "Unit tests" and ts "Typecheck" /
# "Unit tests" steps are commands written INLINE in the workflow YAML, so
# preflight-check.sh had to replicate them rather than call a shared script
# (per SPEC's anti-duplication rule, that replication needs its own parity
# check or a drift becomes silent — this workspace has already been burned
# once by a private second copy of a seed list making tests and prod run
# different catalogs).
#
# Each pair below is (a command CI runs literally) x (the same string must
# appear literally in preflight-check.sh). A workflow edit that changes one of
# these commands without touching preflight-check.sh — or vice versa — now
# fails loudly here instead of quietly making the local gate weaker or
# stronger than CI's.
#
# This does NOT assert step ORDER or grouping, only that the exact command
# text exists in both files; that is the level at which "local gate ==
# CI gate" actually matters (a differently-ordered but identical set of
# commands still gives the same verdict).
#
# Usage: scripts/preflight-parity.sh
# Exit 0 = every command string appears in both files, 1 = drift found,
# 2 = one of the two files is missing (broken checker, not a finding).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
CHECKER="$REPO_ROOT/scripts/preflight-check.sh"

for f in "$WORKFLOW" "$CHECKER"; do
  if [ ! -f "$f" ]; then
    echo "::error::preflight-parity.sh: $f does not exist — cannot compare, this is a broken checker" >&2
    exit 2
  fi
done

# "<label>|<command substring>" — the substring must appear VERBATIM in both
# files. Kept as literal strings, not derived, because the whole point is a
# byte-for-byte match against ci.yml's inline command bodies; deriving one side
# from the other would just move the single point of failure, not remove it.
PAIRS=(
  "go: gofmt -l|gofmt -l ."
  "go: build|go build ./..."
  "go: vet|go vet ./..."
  "go: unit tests|go test ./..."
  "ts: typecheck|npm run typecheck"
  "ts: unit tests|npm test"
  "web: typecheck|npm run typecheck"
  "web: unit tests|npm test"
  "go: unreleased-go|./scripts/tag-hygiene.sh unreleased-go"
  "changelogs: order|./scripts/changelog-hygiene.sh order"
  "taxonomy|scripts/taxonomy-parity.py"
)

FAILED=0
for pair in "${PAIRS[@]}"; do
  label="${pair%%|*}"
  cmd="${pair#*|}"
  in_workflow=0; in_checker=0
  grep -qF -- "$cmd" "$WORKFLOW" && in_workflow=1
  grep -qF -- "$cmd" "$CHECKER" && in_checker=1
  if [ "$in_workflow" = "1" ] && [ "$in_checker" = "1" ]; then
    echo "OK — \`$label\` (\`$cmd\`) appears in both ci.yml and preflight-check.sh."
  else
    echo "::error::DRIFT — \`$label\` command '$cmd' is in ci.yml=$in_workflow preflight-check.sh=$in_checker (want both 1)" >&2
    FAILED=1
  fi
done

if [ "$FAILED" != "0" ]; then
  echo ""
  echo "ci.yml and scripts/preflight-check.sh have drifted — a local 'make check'"
  echo "pass can no longer be trusted to predict CI's push/PR gate. Update"
  echo "whichever side is stale."
  exit 1
fi
exit 0
