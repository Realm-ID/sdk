#!/usr/bin/env bash
# Changelog hygiene — a version may not publish without its own entry.
#
# THE FAULT THIS EXISTS FOR: nothing failed when a release skipped its
# changelog, so three packages lost history independently and nobody noticed
# until someone went looking:
#
#   @realm-id/sdk (ts)     0.29.0–0.35.0 missing — seven releases, found 2026-08-06
#   @realm-id/web-admin    0.8.13–0.8.17 missing — found 2026-08-03; their ONLY
#                          record was a prose paragraph in a DIFFERENT repo's
#                          vendoring README
#   dev.realmid:sdk (java) java-v0.34.0 missing
#
# Three packages, one mechanism. Backfilling the entries fixes none of it — the
# next release skips again — which is why this gate landed before the backfills.
#
# Writing it then found the same fault one degree worse: `@realm-id/web`,
# `@realm-id/web-react` and `@realm-id/web-bff-realmid` had no CHANGELOG.md AT
# ALL, across fourteen published versions between them. A missing file reads as
# "this package doesn't keep one" and so never looks wrong; a missing entry at
# least leaves a hole between two version numbers. Seeded 2026-08-24.
#
# ── Design notes ──────────────────────────────────────────────────────────────
#
# SUBJECTS ARE DERIVED, NEVER LISTED. `npm` mode globs `web/packages/*` and adds
# `ts`; a package added tomorrow is covered the day it exists. This workspace has
# been burned repeatedly by guards whose subject list was hand-maintained (root
# TODO.md § the 2026-08-02 sweep), so the list is the filesystem's.
#
# IT REFUSES TO INSPECT NOTHING. Zero subjects is a hard error, not a pass — the
# failure mode of a derived list is that the derivation silently stops matching,
# and "checked 0 packages, all fine" is how that reports.
#
# IT REFUSES TO SWALLOW UNPARSEABLE INPUT. A package.json with no top-level
# version, or two, exits 2 rather than skipping the package. A gate that treats
# input it cannot read as input that passed is worse than no gate (root TODO.md
# § the swagger guard that `continue`d on a decode error).
#
# THE VERSION MUST BE A WHOLE TOKEN. `0.4.5` must not be satisfied by a heading
# for `0.4.50`, and `0.3.6` must not be satisfied by `10.3.6` — hence the
# non-[0-9.] boundary on both sides. It deliberately does NOT pin the heading's
# shape beyond that: `## 0.37.0 — …` (ts), `## 0.8.19` (web-admin) and
# `## java-v0.35.0` (java) are all live conventions and all correct.
#
# ORDERING. Every mode runs BEFORE its publish step, where the remedy is simply
# "write the entry" — except `go`, which cannot: that module publishes by tag
# push alone, so this runs after the fact. The remedy there is still to write the
# entry (prose is not immutable the way a module hash is), which is why a
# permanently-red gate is not the hazard it would be for the version const.
#
# Usage:
#   changelog-hygiene.sh npm      # ts/ + every non-private web/packages/*
#   changelog-hygiene.sh maven    # java/
#   changelog-hygiene.sh go       # go/, recorded in the monorepo CHANGELOG.md
#
# Exit 0 = pass, 1 = a release has no entry, 2 = usage/parse/environment error.

set -euo pipefail

# Emit to stdout and, under Actions, to the job summary. Same shape as
# tag-hygiene.sh, so a red publish job reads as one document.
say() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

FAILED=0

# Read exactly one top-level "<key>": "<value>" out of a package.json. Top-level
# fields sit at two-space indent, so this cannot be satisfied by a nested
# dependency's version. Anything other than exactly one match is fatal.
json_field() {
  local file="$1" key="$2" n
  n=$(grep -cE "^  \"$key\": " "$file" || true)
  if [ "$n" != "1" ]; then
    echo "::error::$file: expected exactly 1 top-level \"$key\", found $n" >&2
    exit 2
  fi
  sed -nE "s/^  \"$key\": \"?([^\",]*)\"?,?$/\1/p" "$file"
}

# The whole rule, in one place: does <changelog> carry a `## ` heading naming
# <version> as a whole token?
has_entry() {
  local changelog="$1" version="$2" escaped
  escaped=$(printf '%s' "$version" | sed 's/\./\\./g')
  grep -qE "^## (.*[^0-9.])?${escaped}([^0-9.]|\$)" "$changelog"
}

report() {
  local label="$1" version="$2" changelog="$3"
  if [ ! -f "$changelog" ]; then
    say "- ❌ **\`$label\` \`$version\`** — \`$changelog\` does not exist."
    echo "::error::$label: $changelog does not exist; every published package keeps a changelog" >&2
    FAILED=1
    return
  fi
  if has_entry "$changelog" "$version"; then
    say "- ✅ \`$label\` \`$version\` — entry present in \`$changelog\`."
  else
    say "- ❌ **\`$label\` \`$version\`** — no \`## $version\` heading in \`$changelog\`."
    echo "::error::$label $version has no entry in $changelog" >&2
    FAILED=1
  fi
}

check_npm() {
  local dirs=() d name version private count=0
  # DERIVED, not listed. ts/ is the standalone package; the rest are workspaces.
  [ -f ts/package.json ] && dirs+=(ts)
  for d in web/packages/*/; do
    [ -f "${d}package.json" ] && dirs+=("${d%/}")
  done

  # BEFORE the loop, not after: under `set -u` an empty array makes
  # `for d in "${dirs[@]}"` abort with "unbound variable" — exit 1, no
  # diagnosis — so a post-loop count check is unreachable in exactly the case
  # it exists for. Found by mutating the derivation to return nothing.
  if [ "${#dirs[@]}" -eq 0 ]; then
    echo "::error::changelog-hygiene npm found no ts/ or web/packages/*/package.json at all — run it from the sdk repo root; the derivation is broken, not clean" >&2
    exit 2
  fi

  say "## Changelog hygiene — npm"
  say ""
  for d in "${dirs[@]}"; do
    private=$(grep -cE '^  "private": true' "$d/package.json" || true)
    if [ "$private" != "0" ]; then
      say "- ⏭️  \`$d\` is private — not published, not checked."
      continue
    fi
    name=$(json_field "$d/package.json" name)
    version=$(json_field "$d/package.json" version)
    report "$name" "$version" "$d/CHANGELOG.md"
    count=$((count + 1))
  done

  # The second half of the same rule: the directories exist but every one of
  # them is private, so nothing was actually checked.
  if [ "$count" = "0" ]; then
    echo "::error::changelog-hygiene npm inspected 0 publishable packages — the ts/ + web/packages/* derivation is broken, not clean" >&2
    exit 2
  fi
  say ""
  say "Checked $count publishable npm package(s)."
}

check_maven() {
  local version n
  n=$(grep -cE '^version = "' java/build.gradle.kts || true)
  if [ "$n" != "1" ]; then
    echo "::error::expected exactly 1 'version = ' declaration in java/build.gradle.kts, found $n" >&2
    exit 2
  fi
  version=$(sed -nE 's/^version = "(.*)"$/\1/p' java/build.gradle.kts)
  say "## Changelog hygiene — Maven Central"
  say ""
  # java/CHANGELOG.md heads its entries `## java-v0.35.0`; the token boundary
  # accepts that and `## 0.35.0` alike.
  report "dev.realmid:sdk" "$version" java/CHANGELOG.md
}

check_go() {
  local version n
  n=$(grep -c '^const Version = "' go/realmid.go || true)
  if [ "$n" != "1" ]; then
    echo "::error::expected exactly 1 'const Version =' declaration in go/realmid.go, found $n" >&2
    exit 2
  fi
  version=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' go/realmid.go)
  say "## Changelog hygiene — Go module"
  say ""
  # go/ has no changelog of its own by design: its releases are recorded in the
  # monorepo CHANGELOG, whose headings name each language and version
  # (`… — go \`0.45.0\` · ts \`0.37.0\` …`). So the subject here is that file and
  # the match must name GO's version, not merely the number.
  if grep -qE "^## .*go \`${version//./\\.}\`" CHANGELOG.md; then
    say "- ✅ \`github.com/Realm-ID/sdk/go\` \`$version\` — entry present in \`CHANGELOG.md\`."
  else
    say "- ❌ **\`github.com/Realm-ID/sdk/go\` \`$version\`** — no monorepo \`CHANGELOG.md\` heading names \`go \\\`$version\\\`\`."
    say ""
    say "The Go module publishes by tag push, so this ran AFTER the release. The"
    say "remedy is to write the entry — never to re-point the tag."
    echo "::error::go $version has no entry in CHANGELOG.md" >&2
    FAILED=1
  fi
}

case "${1:-}" in
  npm)   check_npm ;;
  maven) check_maven ;;
  go)    check_go ;;
  *)     echo "usage: $0 {npm|maven|go}" >&2; exit 2 ;;
esac

if [ "$FAILED" != "0" ]; then
  say ""
  say "**A release may not publish without a changelog entry.** Add a \`## <version>\`"
  say "heading for the version above and re-run. Three packages lost history to this"
  say "exact silence before the gate existed (see the header of this script)."
  exit 1
fi
exit 0
