#!/usr/bin/env bash
# Tests for `tag-hygiene.sh unreleased-go` when the local clone has NO go/v* tags.
#
# The shape that matters: a clone without tags answers "no tag yet, go/ may change freely", which is
# indistinguishable from the real "nothing released" case and silently disables the gate. Each case
# runs in a throwaway clone under .scratch/ (never the main checkout; tags are shared across worktrees,
# so a worktree would not isolate them) whose `origin` is a local path, so nothing touches GitHub.
#
# Usage: scripts/tag-hygiene.test.sh      Exit 0 = all pass.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO_ROOT/.scratch/tag-hygiene-test"
rm -rf "$WORK"; mkdir -p "$WORK"
FAILED=0

# Source repo: copy of HEAD's go/realmid.go version + the script, with chosen tags.
mkorigin() { # <dir> <tag...>
  local d="$1"; shift
  mkdir -p "$d/go" "$d/scripts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t; git -C "$d" config user.name t; git -C "$d" config tag.gpgsign false
  printf 'package realmid\n\nconst Version = "0.1.0"\n' > "$d/go/realmid.go"
  cp "$REPO_ROOT/scripts/tag-hygiene.sh" "$d/scripts/"
  git -C "$d" add -A; git -C "$d" commit -qm init
  for t in "$@"; do git -C "$d" tag -a "$t" -m "$t"; done
}

# expect <name> <want-rc> <want-text> <dir>
expect() {
  local name="$1" want="$2" text="$3" dir="$4" out rc
  out=$(cd "$dir" && ./scripts/tag-hygiene.sh unreleased-go 2>&1); rc=$?
  if [ "$rc" = "$want" ] && printf '%s' "$out" | grep -q "$text"; then
    echo "  ok   $name"
  else
    echo "  FAIL $name (rc=$rc, want rc=$want and text '$text')"; printf '%s\n' "$out" | sed 's/^/       /'
    FAILED=1
  fi
}

# 1. Remote HAS the released tag, clone has none: the script fetches it, compares, and says what.
mkorigin "$WORK/o1" go/v0.1.0
git clone -q --no-tags "$WORK/o1" "$WORK/c1"
expect "tags fetched when missing locally; names the tag and sha" 0 "compared against go/v0.1.0 (" "$WORK/c1"

# 2. Version bumped and not yet tagged: the remote has only an OLDER go/ tag. The fetch brings it in and
#    the script says there is no tag for this version yet (the legitimate pre-release state).
mkorigin "$WORK/o2" go/v0.0.9
git clone -q --no-tags "$WORK/o2" "$WORK/c2"
expect "version bumped, older go/ tags only: OK no tag yet" 0 "no .go/v0.1.0. tag yet" "$WORK/c2"

# 3. Remote truly has no go/ tag: OK no tag yet.
mkorigin "$WORK/o3"
git clone -q --no-tags "$WORK/o3" "$WORK/c3"
expect "remote has no go/ tag at all: OK no tag yet" 0 "no .go/v0.1.0. tag yet" "$WORK/c3"

# 4. Remote cannot be reached and no local go/ tag: cannot compare -> fail loudly (exit 2).
mkorigin "$WORK/o4"
git clone -q --no-tags "$WORK/o4" "$WORK/c4"
git -C "$WORK/c4" remote set-url origin "$WORK/does-not-exist"
expect "cannot reach origin, no local tag: fails loudly" 2 "could not compare" "$WORK/c4"

rm -rf "$WORK"
[ "$FAILED" = 0 ] && echo "tag-hygiene tests: PASS" || { echo "tag-hygiene tests: FAIL"; exit 1; }
