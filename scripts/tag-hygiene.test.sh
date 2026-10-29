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

# --- add-on module tags (R35/R95): go/secrets/gsm/vX and go/secrets/redis/vX -----------------------
# `module-of <tag>` prints "<module path> <version>"; the sumdb check keys on the module, so the
# add-on forms must resolve to THEIR module and anything else must be refused (exit 2).
modof() { # <name> <tag> <want-rc> <want-text>
  local out rc
  out=$(cd "$REPO_ROOT" && ./scripts/tag-hygiene.sh module-of "$2" 2>&1); rc=$?
  if [ "$rc" = "$3" ] && printf '%s' "$out" | grep -qF -- "$4"; then echo "  ok   $1"
  else echo "  FAIL $1 (rc=$rc, want rc=$3 and text '$4')"; printf '%s\n' "$out" | sed 's/^/       /'; FAILED=1; fi
}
modof "core tag" go/v0.70.0 0 "github.com/Realm-ID/sdk/go v0.70.0"
modof "gsm add-on tag" go/secrets/gsm/v0.1.0 0 "github.com/Realm-ID/sdk/go/secrets/gsm v0.1.0"
modof "redis add-on tag" go/secrets/redis/v1.2.3 0 "github.com/Realm-ID/sdk/go/secrets/redis v1.2.3"
modof "unknown add-on refused" go/secrets/vault/v0.1.0 2 "unsupported"
modof "add-on without a version refused" go/secrets/gsm/latest 2 "unsupported"

# An add-on is its own module, so a change under go/secrets/ is not a change to the CORE's tree:
# `unreleased-go` must not demand a core const Version bump for it, but still demands one for go/.
mkorigin "$WORK/o5" go/v0.1.0
mkdir -p "$WORK/o5/go/secrets/gsm"; echo 'module x' > "$WORK/o5/go/secrets/gsm/go.mod"
git -C "$WORK/o5" add -A; git -C "$WORK/o5" commit -qm addon
expect "change only under go/secrets/ does not trip the core gate" 0 "identical to the released" "$WORK/o5"
echo '// core change' >> "$WORK/o5/go/realmid.go"
git -C "$WORK/o5" add -A; git -C "$WORK/o5" commit -qm core
expect "core change under a released version still trips it" 1 "HAS CHANGED UNDER A RELEASED VERSION" "$WORK/o5"

rm -rf "$WORK"
[ "$FAILED" = 0 ] && echo "tag-hygiene tests: PASS" || { echo "tag-hygiene tests: FAIL"; exit 1; }
