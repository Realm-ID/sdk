#!/usr/bin/env bash
# Tests for .githooks/pre-push.
#
# WHY. The hook is the LAST point at which a bad release can be prevented: every
# gate in the publish workflows runs after the tag exists, and a `go/vX.Y.Z` tag
# is immutable the instant proxy.golang.org serves it. A hook that silently
# stopped gating would look exactly like a clean repo — the same shape as every
# other "green means nothing ran" failure this repo has been burned by.
#
# These cases are the ones that were exercised by hand when the tag half was
# added (2026-09-18); writing them down is what stops the next edit from
# un-gating tags without anyone noticing.
#
# The hook runs `make release-check` / `make check` for real, so this is not
# instant. It takes no network and no secrets.
#
# Usage: scripts/pre-push.test.sh
# Exit 0 = all cases pass, 1 = a case failed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/.githooks/pre-push"
cd "$REPO_ROOT" || exit 1

ZERO=0000000000000000000000000000000000000000
SHA="$(git rev-parse HEAD)"
FAILS=0

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILS=$((FAILS + 1)); }

# Feed the hook one ref line, return its exit code, capture output in $OUT.
run_hook() {
  OUT=$(printf '%s %s %s %s\n' "$1" "$SHA" "$1" "$ZERO" | "$HOOK" origin git@github.com:Realm-ID/sdk.git 2>&1)
  return $?
}

echo "pre-push.test.sh"

# ── 1. a LIGHTWEIGHT release tag is refused ─────────────────────────────────
# `tag.annotate` is true globally on this machine, so `git tag <name>` cannot
# even create one — hence update-ref. That is also why this case is easy to
# believe is impossible and is not.
git update-ref refs/tags/go/v9.9.9 "$SHA"
if run_hook refs/tags/go/v9.9.9; then
  fail "a lightweight go/v* tag was ACCEPTED"
else
  case "$OUT" in
    *LIGHTWEIGHT*) pass "a lightweight go/v* tag is refused, and the message says how to re-cut it" ;;
    *) fail "refused, but not for being lightweight: $OUT" ;;
  esac
fi
git update-ref -d refs/tags/go/v9.9.9

# ── 2. an annotated tag whose version does not exist runs release-check ─────
# The point is not the specific error; it is that release-check RAN at all.
# Before this hook gated tags, `git push origin <tag>` asked nothing.
git tag -a ts-v9.9.9 -m "test" "$SHA" >/dev/null 2>&1
if run_hook refs/tags/ts-v9.9.9; then
  fail "release-check did not fire for an annotated ts tag at a nonexistent version"
else
  pass "an annotated release tag runs make release-check and its verdict is the hook's"
fi
git tag -d ts-v9.9.9 >/dev/null 2>&1

# ── 3. an UNRECOGNISED tag is reported, not silently waved through ──────────
# A new publish lane arrives as a tag form nothing has a rule for. A gate that
# shrugs at one is how the next lane ships ungated.
git tag -a web-v9.9.9 -m "test" "$SHA" >/dev/null 2>&1
run_hook refs/tags/web-v9.9.9
case "$OUT" in
  *"no release-check rule"*) pass "an unrecognised release tag is called out rather than passed silently" ;;
  *) fail "an unrecognised tag produced no notice: $OUT" ;;
esac
git tag -d web-v9.9.9 >/dev/null 2>&1

# ── 4. a BRANCH push still runs make check ─────────────────────────────────
# The control. Without it, a hook that only gated tags would pass every case
# above while removing the gate that already existed.
if run_hook refs/heads/main; then
  case "$OUT" in
    *"make check"*) pass "a branch push still runs make check" ;;
    *) fail "a branch push passed without running make check: $OUT" ;;
  esac
else
  fail "a branch push FAILED its gate — fix the tree before reading this suite"
fi

# ── 5. the bypass still works ──────────────────────────────────────────────
# Documented in the hook's own header; a bypass that stopped working would be
# discovered during an incident, which is the worst possible time.
OUT=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$SHA" "$ZERO" | REALMID_SKIP_PREPUSH=1 "$HOOK" origin x 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && [ "${OUT#*SKIPPED}" != "$OUT" ]; then
  pass "REALMID_SKIP_PREPUSH=1 bypasses the hook and says so"
else
  fail "the documented bypass did not work (rc=$rc): $OUT"
fi

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "pre-push.test.sh: PASS"
  exit 0
fi
echo "pre-push.test.sh: FAIL — $FAILS case(s)"
exit 1
