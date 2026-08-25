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
#   changelog-hygiene.sh order    # every per-package changelog is in descending order
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

# ── order mode ────────────────────────────────────────────────────────────────
#
# THE FAULT THIS EXISTS FOR, and it is the SAME fault as the modes above wearing
# a different hat. `ts/CHANGELOG.md`'s `0.36.0` (2026-08-06) sat between `0.29.0`
# and `0.28.0`, six releases out of descending order — found 2026-08-25 by hand,
# while verifying the backfill of the seven entries this script's header names.
#
# A reader scanning a descending changelog stops at the first heading below the
# version they want. So a heading in the wrong place is invisible in exactly the
# way a MISSING heading is — present and unreachable reads the same as absent —
# and the modes above cannot see it: they ask whether the version being
# published has a heading, which says nothing about the order of the ones
# beneath it. That is also why the backfill itself could only be spot-checked by
# `grep`.
#
# THE ROOT `CHANGELOG.md` IS DELIBERATELY NOT CHECKED, and the reason is
# measured, not assumed: its headings name up to three languages at once
# (`… go \`0.47.0\` · ts \`0.39.0\` · java \`0.37.0\``), so there is no single
# version to order by, and **15 of its 64 headings carry no date either**. There
# is no total order to assert over that file. Asserting one anyway would mean
# inventing a rule the file has never followed — a gate that fails on correct
# input teaches people to pass `--no-verify`, which is worse than no gate.
#
# `## Unreleased` is accepted ONLY as the first heading, which is the convention
# it belongs to. Anywhere else it is a released entry that never got its number
# (that is exactly what it was in ts/, recovered as `0.13.0` the same day) and
# the file has no order at that point.

# ver_gt <a> <b> — true when version a sorts strictly ABOVE version b.
# Component-wise numeric compare; a missing component reads as 0, so 0.8 and
# 0.8.0 compare equal rather than one being "shorter".
ver_gt() {
  local a="$1" b="$2" i ac bc
  local -a A B
  IFS='.' read -r -a A <<< "$a"
  IFS='.' read -r -a B <<< "$b"
  for ((i = 0; i < ${#A[@]} || i < ${#B[@]}; i++)); do
    ac=${A[i]:-0}; bc=${B[i]:-0}
    if ((10#$ac > 10#$bc)); then return 0; fi
    if ((10#$ac < 10#$bc)); then return 1; fi
  done
  return 1
}

check_order() {
  local files=() d f count=0 headings=0
  # DERIVED, not listed — same rule as check_npm, same reason.
  [ -f ts/CHANGELOG.md ] && files+=(ts/CHANGELOG.md)
  [ -f java/CHANGELOG.md ] && files+=(java/CHANGELOG.md)
  for d in web/packages/*/; do
    [ -f "${d}CHANGELOG.md" ] && files+=("${d}CHANGELOG.md")
  done
  # BEFORE the loop, for the `set -u` reason documented in check_npm.
  if [ "${#files[@]}" -eq 0 ]; then
    echo "::error::changelog-hygiene order found no per-package CHANGELOG.md at all — run it from the sdk repo root; the derivation is broken, not clean" >&2
    exit 2
  fi

  say "## Changelog hygiene — descending order"
  say ""
  for f in "${files[@]}"; do
    local prev="" prev_line="" line no text ver first=1 bad=0
    while IFS= read -r line; do
      no=${line%%:*}
      text=${line#*:}
      headings=$((headings + 1))
      # `## Unreleased` is legal at the top and nowhere else.
      if [[ "$text" =~ ^\#\#[[:space:]]+Unreleased ]]; then
        if [ "$first" = "1" ]; then first=0; continue; fi
        say "- ❌ **\`$f:$no\`** — \`## Unreleased\` below a released entry. It is a release that never got its number; the file has no order from here down."
        echo "::error file=$f,line=$no::## Unreleased appears below a released entry" >&2
        bad=1; FAILED=1
        continue
      fi
      first=0
      # A leading version token, optionally prefixed `java-v` / `ts-v` / `v`.
      ver=$(printf '%s' "$text" | sed -nE 's/^## (java-v|ts-v|v)?([0-9]+(\.[0-9]+)*).*/\2/p')
      if [ -z "$ver" ]; then
        # REFUSE TO SWALLOW UNPARSEABLE INPUT — the rule this script already
        # states for package.json. A heading we cannot read is a heading we
        # cannot order, and "skipped it" would report as "in order".
        say "- ❌ **\`$f:$no\`** — heading names no version: \`$text\`"
        echo "::error file=$f,line=$no::changelog heading names no version, so its order cannot be checked" >&2
        bad=1; FAILED=1
        continue
      fi
      if [ -n "$prev" ]; then
        if ver_gt "$ver" "$prev"; then
          say "- ❌ **\`$f:$no\`** — \`$ver\` sits BELOW \`$prev\` (\`$f:$prev_line\`). A reader scanning down stops before it."
          echo "::error file=$f,line=$no::$ver is out of descending order (below $prev at line $prev_line)" >&2
          bad=1; FAILED=1
        elif [ "$ver" = "$prev" ]; then
          say "- ❌ **\`$f:$no\`** — \`$ver\` appears twice (also \`$f:$prev_line\`)."
          echo "::error file=$f,line=$no::duplicate changelog heading for $ver" >&2
          bad=1; FAILED=1
        fi
      fi
      prev="$ver"; prev_line="$no"
    done < <(grep -nE '^## ' "$f" || true)
    [ "$bad" = "0" ] && say "- ✅ \`$f\` — in descending order."
    count=$((count + 1))
  done

  # IT REFUSES TO INSPECT NOTHING, at both levels: files found but no headings
  # in any of them means the `^## ` convention moved and this checked air.
  if [ "$headings" = "0" ]; then
    echo "::error::changelog-hygiene order inspected $count file(s) and 0 headings — the '^## ' convention changed; this is a broken derivation, not a clean run" >&2
    exit 2
  fi
  say ""
  say "Checked $count changelog(s), $headings heading(s)."
}

case "${1:-}" in
  npm)   check_npm ;;
  maven) check_maven ;;
  go)    check_go ;;
  order) check_order ;;
  *)     echo "usage: $0 {npm|maven|go|order}" >&2; exit 2 ;;
esac

if [ "$FAILED" != "0" ]; then
  say ""
  say "**A release may not publish without a changelog entry, and the entries must"
  say "read in descending order.** Add or move the \`## <version>\`"
  say "heading for the version above and re-run. Three packages lost history to this"
  say "exact silence before the gate existed (see the header of this script)."
  exit 1
fi
exit 0
