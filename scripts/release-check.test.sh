#!/usr/bin/env bash
# Tests for release-check.sh — run BEFORE it in `make self-test`, per the
# checker-tests rule (root CI-FAILURE-AUDIT / .scratch/preflight/SPEC.md):
# `scripts/todo-ranking-hygiene.py` shipped with a defect that read "file
# absent" as "item closed" and turned three consecutive pushes red on a
# finding that was not true. A new verdict-rendering script must fail as a
# broken checker, never silently pass as a clean one.
#
# This sources release-check.sh's functions (guarded not to run `main` when
# sourced) and exercises them against throwaway fixtures — never against this
# repo's real go/ts/java trees, so a test failure can never be confused with a
# real release finding.
#
# Usage: scripts/release-check.test.sh
# Exit 0 = all assertions passed, 1 = a test failed.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0
PASS=0

# shellcheck source=release-check.sh
source "$HERE/release-check.sh"
# release-check.sh sets `-e` for its OWN execution; sourcing it imports that
# into this shell too. This test script wants to keep running after an
# assertion fails (that is the whole point of collecting a PASS count), so
# turn errexit back off immediately — every rc is captured explicitly below.
set +e

assert_eq() {
  local desc="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — want [$want] got [$got]"
    FAILED=1
  fi
}

assert_rc() {
  local desc="$1" want_rc="$2"; shift 2
  local rc=0
  # A SUBSHELL, deliberately: release-check.sh's checkers `exit` on failure
  # (correct for standalone use, where that IS the process exit code) rather
  # than `return` — sourcing the script for these tests means a bare `exit`
  # would otherwise kill this whole test runner instead of failing one case.
  ( "$@" ) >/tmp/release-check-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want_rc" ]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — want rc=$want_rc got rc=$rc"
    echo "  output: $(cat /tmp/release-check-test.out)"
    FAILED=1
  fi
}

## ── field readers ─────────────────────────────────────────────────────────────

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/realmid.go" <<'EOF'
package realmid

const Version = "1.2.3"
EOF
assert_eq "read_go_version reads the const" "1.2.3" "$(read_go_version "$WORK/realmid.go")"

cat > "$WORK/realmid-bad.go" <<'EOF'
package realmid

const Version = "1.2.3"
const Version = "9.9.9"
EOF
assert_rc "read_go_version dies on >1 declaration" 2 read_go_version "$WORK/realmid-bad.go"

cat > "$WORK/realmid-none.go" <<'EOF'
package realmid
EOF
assert_rc "read_go_version dies on 0 declarations" 2 read_go_version "$WORK/realmid-none.go"

cat > "$WORK/package.json" <<'EOF'
{
  "name": "@realm-id/sdk",
  "version": "0.51.0",
  "private": false
}
EOF
assert_eq "read_ts_version reads the top-level field" "0.51.0" "$(read_ts_version "$WORK/package.json")"

# Regression guard: a NESTED "version" (e.g. inside a dependency block) must
# never satisfy the top-level read — it is indented past the two-space anchor.
cat > "$WORK/package-nested.json" <<'EOF'
{
  "name": "x",
  "dependencies": {
    "version": "should-not-match"
  }
}
EOF
assert_rc "read_ts_version dies when no top-level version exists" 2 read_ts_version "$WORK/package-nested.json"

cat > "$WORK/build.gradle.kts" <<'EOF'
group = "dev.realmid"
version = "0.48.0"
EOF
assert_eq "read_java_version reads the declaration" "0.48.0" "$(read_java_version "$WORK/build.gradle.kts")"

## ── tag existence, against a throwaway git repo ────────────────────────────────

GITWORK=$(mktemp -d)
git -c init.defaultBranch=main init -q "$GITWORK"
git -C "$GITWORK" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$GITWORK" tag -a "go/v1.0.0" -m "go/v1.0.0"

REPO_ROOT="$GITWORK"
tag_exists_locally "go/v1.0.0"; got=$?
assert_eq "tag_exists_locally true (rc=0) for a tag that exists" "0" "$got"
tag_exists_locally "go/v9.9.9"; got=$?
assert_eq "tag_exists_locally false (rc!=0) for a tag that does not exist" "1" "$got"
rm -rf "$GITWORK"

echo
echo "$PASS assertion(s) passed."
if [ "$FAILED" != "0" ]; then
  echo "release-check.test.sh: FAILED"
  exit 1
fi
echo "release-check.test.sh: PASS"
exit 0
