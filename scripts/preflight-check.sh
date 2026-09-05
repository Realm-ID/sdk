#!/usr/bin/env bash
# `make check` — mirrors ONLY .github/workflows/ci.yml, the push/PR gate.
# Under 60s, no network, no secrets, no compose stack, no integration suite —
# see the Makefile header for why java/'s gradle test is excluded entirely.
#
# Runs EVERY gate and reports every failure before exiting non-zero, rather
# than stopping at the first — a check that reports one problem when three
# exist wastes the next round trip. Each gate prints the exact command it ran,
# so a failure is reproducible by hand without reading this script.
#
# Usage: scripts/preflight-check.sh
# Exit 0 = every gate passed, 1 = at least one gate failed or was skipped
# (unless PREFLIGHT_ALLOW_SKIP=1, per the SPEC's skip rule — a skip is not a
# pass).

set -uo pipefail  # NOT -e: every gate must run regardless of earlier failures

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAILURES=()
ALLOW_SKIP="${PREFLIGHT_ALLOW_SKIP:-0}"

# gate <name> <command...> — run one gate, print its exact command, record
# pass/fail/skip. `skip <name> <reason>` is the loud-skip path.
gate() {
  local name="$1"; shift
  echo ""
  echo "── $name ──"
  echo "\$ $*"
  if "$@"; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    FAILURES+=("$name")
  fi
}

skip() {
  local name="$1" reason="$2"
  echo ""
  echo "── $name ──"
  echo "SKIPPED: $reason"
  if [ "$ALLOW_SKIP" != "1" ]; then
    FAILURES+=("$name (SKIPPED)")
  fi
}

START=$(date +%s)

# ── parity ──────────────────────────────────────────────────────────────────
# Runs FIRST, deliberately: everything below replicates a CI command, and a
# replica that has silently drifted from what ci.yml actually runs would make
# every later PASS below meaningless (a green local run predicting nothing
# about the next push). See scripts/preflight-parity.sh's header.
gate "workflow/Makefile command parity" ./scripts/preflight-parity.sh

# ── taxonomy job ────────────────────────────────────────────────────────────
# ci.yml `taxonomy` job, "The three taxonomies agree" step.
gate "taxonomy parity" python3 scripts/taxonomy-parity.py

# ── contract parity (SDK vs issuer/docs/swagger.yaml) ───────────────────────
# NOT a ci.yml step yet — this is a repo-local gate, filed in sdk/TODO.md to
# wire into CI once it has run clean for a while. taxonomy-parity.py above
# compares the three SDKs against EACH OTHER, which cannot catch all three
# agreeing and being wrong about the server (see contract-parity.py's own
# header for the two documented defects that shape covers).
#
# The self-test runs FIRST, per the checker-tests rule
# (scripts/contract-parity.test.py's header cites the same precedent as
# scripts/release-check.test.sh): a verdict-rendering script must fail as a
# broken checker, never silently pass as a clean one.
gate "contract parity: self-test" python3 scripts/contract-parity.test.py
gate "contract parity (SDK vs swagger.yaml)" python3 scripts/contract-parity.py

# ── changelogs job ──────────────────────────────────────────────────────────
# ci.yml `changelogs` job, "Every per-package changelog is in descending order".
gate "changelog order" ./scripts/changelog-hygiene.sh order

# ── go job ──────────────────────────────────────────────────────────────────
# ci.yml `go` job. Order matches the workflow: unreleased-go check, gofmt,
# build+vet, unit tests.
gate "go: unreleased version has not changed" ./scripts/tag-hygiene.sh unreleased-go

gofmt_check() {
  local unformatted
  unformatted=$(cd go && gofmt -l .)
  if [ -n "$unformatted" ]; then
    echo "::error::gofmt reports unformatted files:"
    echo "$unformatted"
    (cd go && gofmt -d .)
    return 1
  fi
  echo "gofmt clean"
}
gate "go: gofmt" gofmt_check

gate "go: build" bash -c 'cd go && go build ./...'
gate "go: vet" bash -c 'cd go && go vet ./...'
gate "go: unit tests" bash -c 'cd go && go test ./...'

# ── ts job ──────────────────────────────────────────────────────────────────
# ci.yml `ts` job's typecheck + test steps. Deliberately NOT `npm ci` first —
# that needs network, which `check` may never touch. If ts/node_modules is
# missing this is a loud SKIP (install it yourself: `cd ts && npm ci`), not a
# silent pass and not a surprise network call.
if [ -d ts/node_modules ]; then
  gate "ts: typecheck" bash -c 'cd ts && npm run typecheck'
  gate "ts: unit tests" bash -c 'cd ts && npm test'
else
  skip "ts: typecheck" "ts/node_modules is missing — run 'cd ts && npm ci' once (needs network), then re-run make check"
  skip "ts: unit tests" "ts/node_modules is missing — run 'cd ts && npm ci' once (needs network), then re-run make check"
fi

# ── web job ─────────────────────────────────────────────────────────────────
# ci.yml `web` job's typecheck + test steps. Same loud-skip shape as ts above
# (no npm ci here — no network in `check`). `npm test` here runs only the 4
# packages that define a `test` script (core, admin, bff-realmid, google) via
# `--workspaces --if-present`; react and firebase have none — see sdk/TODO.md.
if [ -d web/node_modules ]; then
  gate "web: typecheck (all packages)" bash -c 'cd web && npm run typecheck'
  gate "web: unit tests (core, admin, bff-realmid, google)" bash -c 'cd web && npm test'
else
  skip "web: typecheck (all packages)" "web/node_modules is missing — run 'cd web && npm ci' once (needs network), then re-run make check"
  skip "web: unit tests (core, admin, bff-realmid, google)" "web/node_modules is missing — run 'cd web && npm ci' once (needs network), then re-run make check"
fi

# java/'s gradle job is intentionally absent — see Makefile header.

ELAPSED=$(( $(date +%s) - START ))

echo ""
echo "════════════════════════════════════════"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "make check: PASS (${ELAPSED}s)"
  exit 0
fi

echo "make check: FAIL (${ELAPSED}s) — ${#FAILURES[@]} gate(s):"
for f in "${FAILURES[@]}"; do
  echo "  - $f"
done
exit 1
