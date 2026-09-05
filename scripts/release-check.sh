#!/usr/bin/env bash
# release-check — assert the version/changelog/tag preconditions for a release
# BEFORE the tag exists, for whichever language is about to publish.
#
# THE FAULT THIS EXISTS FOR. Every one of this repo's release-time gates
# (verify-go-release.yml's const-vs-tag check, tag-hygiene.sh's annotated /
# go-immutable modes, changelog-hygiene.sh's npm/maven/go modes) runs AFTER a
# tag has been pushed. For ts/java that is merely late — the tag is still
# recoverable (delete + `git tag -a` re-cut) because nothing has published yet.
# For Go it is terminal: `go/v*` publishes by tag push ALONE, so by the time
# `verify-go-release.yml` runs, proxy.golang.org may already have served the
# tree, and the module hash sum.golang.org records for that version is fixed
# forever. `go/v0.58.0` is burned exactly this way (root TODO.md, DECISIONS.md
# 2026-07-05) — a later commit had to bump `const Version` to 0.58.1 rather
# than fix the released tag. This script runs the SAME assertions the tag-push
# gates would make, against the working tree, so the operator finds out before
# cutting the tag rather than after.
#
# ── Why the three languages are NOT one rule ──────────────────────────────────
#
# Go's tag IS the release: nothing can un-happen once proxy.golang.org has
# cached a version, so the ONLY safe remedy for a discovered problem is the
# next patch version. ts/java publish from a PUBLISH STEP that runs after the
# tag push (publish-npm.yml / publish-maven.yml), so a bad tag there is still
# fixable by deleting and re-cutting — this script treats a locally-existing
# ts-v*/java-v* tag as a hard stop for the SAME version anyway (Central and npm
# both reject a republish of an already-served version), but the reasoning is
# "don't waste the version number", not "the internet has already seen this".
#
# ── What each language checks ──────────────────────────────────────────────────
#
#   go    go/realmid.go's `const Version` must ALREADY read <version> (the
#         const bump belongs in the same PR as the code, never in a release
#         commit written after the fact — that ordering is what let
#         `go/v0.58.0` ship with a stale const to begin with). Then:
#           - changelog-hygiene.sh go       (entry exists for that version)
#           - tag-hygiene.sh unreleased-go  (defence in depth: go/ has not
#             drifted from whatever WAS most recently released)
#           - go/v<version> must not already exist as a tag, locally or (best
#             effort) on origin
#
#   ts    ts/package.json's version must already read <version>. Then:
#           - changelog-hygiene.sh npm   (covers ts/ + every web/packages/*,
#             which is what the real publish-npm.yml gate checks)
#           - ts-v<version> must not already exist as a tag
#
#   java  java/build.gradle.kts's version must already read <version>. Then:
#           - changelog-hygiene.sh maven
#           - java-v<version> must not already exist as a tag
#
# The remote tag probe is BEST EFFORT: this script has no "no network" contract
# (only `make check` does), but a release-check must still be usable offline,
# so a probe that cannot reach origin is a warning, never a failure — the local
# check is the one that matters and is already authoritative for "did I already
# cut this".
#
# Usage:   release-check.sh <go|ts|java> <version>     e.g. release-check.sh go 0.58.1
# Exit 0 = clear to tag, 1 = a precondition failed, 2 = usage/environment error.
#
# Functions below are written to be sourced by scripts/release-check.test.sh
# without running main — guarded at the bottom by the BASH_SOURCE check.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die_usage() {
  echo "usage: $0 {go|ts|java} <version>" >&2
  exit 2
}

# read_field <file> <sed-pattern> <label> — extract exactly one value or die
# with a usage error. Shared shape with tag-hygiene.sh / changelog-hygiene.sh's
# "exactly one match or exit 2" rule: input this script cannot parse must never
# read as input that passed.
read_go_version() {
  local file="$1" n
  n=$(grep -c '^const Version = "' "$file" || true)
  if [ "$n" != "1" ]; then
    echo "::error::expected exactly 1 'const Version =' declaration in $file, found $n" >&2
    exit 2
  fi
  sed -n 's/^const Version = "\(.*\)"$/\1/p' "$file"
}

read_ts_version() {
  local file="$1" n
  n=$(grep -cE '^  "version": ' "$file" || true)
  if [ "$n" != "1" ]; then
    echo "::error::expected exactly 1 top-level \"version\" in $file, found $n" >&2
    exit 2
  fi
  sed -nE 's/^  "version": "?([^",]*)"?,?$/\1/p' "$file"
}

read_java_version() {
  local file="$1" n
  n=$(grep -cE '^version = "' "$file" || true)
  if [ "$n" != "1" ]; then
    echo "::error::expected exactly 1 'version = ' declaration in $file, found $n" >&2
    exit 2
  fi
  sed -nE 's/^version = "(.*)"$/\1/p' "$file"
}

# tag_exists_locally <tag> — 0 if the ref exists in this checkout.
tag_exists_locally() {
  git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$1" >/dev/null 2>&1
}

# tag_exists_remotely <tag> — best-effort. Prints one of: yes / no / unknown.
# `unknown` (no network, no `origin`, or the remote timed out) is deliberately
# NOT a failure — this script has no no-network contract, unlike `make check`.
tag_exists_remotely() {
  local tag="$1" out
  if ! git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
    echo unknown; return
  fi
  if out=$(git -C "$REPO_ROOT" ls-remote --tags --exit-code origin "refs/tags/$tag" 2>/dev/null); then
    [ -n "$out" ] && echo yes || echo no
  else
    local rc=$?
    # `ls-remote --exit-code` returns 2 for "ref not found" — that IS a known
    # answer (no), not an unreachable remote. Anything else is genuinely
    # unknown (network down, auth, timeout).
    if [ "$rc" = "2" ]; then echo no; else echo unknown; fi
  fi
}

check_go() {
  local version="$1" const tag remote
  const=$(read_go_version "$REPO_ROOT/go/realmid.go")
  if [ "$const" != "$version" ]; then
    echo "::error::go/realmid.go declares Version=\"$const\", not the requested $version — bump the const in the same change that will be tagged, before cutting go/v$version" >&2
    exit 1
  fi
  echo "OK — go/realmid.go already declares Version=\"$version\"."

  tag="go/v$version"
  if tag_exists_locally "$tag"; then
    echo "::error::$tag already exists locally. The Go module publishes by tag push alone and proxy.golang.org may already have served it — re-pointing it breaks every downstream go.sum (2026-07-05 incident). Ship the NEXT PATCH VERSION instead." >&2
    exit 1
  fi
  remote=$(tag_exists_remotely "$tag")
  case "$remote" in
    yes) echo "::error::$tag already exists on origin (immutable once proxy.golang.org has cached it). Ship the NEXT PATCH VERSION instead." >&2; exit 1 ;;
    no)  echo "OK — $tag does not exist locally or on origin." ;;
    unknown) echo "WARNING — could not reach origin to confirm $tag is unclaimed there; local check passed." ;;
  esac

  "$REPO_ROOT/scripts/changelog-hygiene.sh" go
  "$REPO_ROOT/scripts/tag-hygiene.sh" unreleased-go
}

check_ts() {
  local version="$1" have tag remote
  have=$(read_ts_version "$REPO_ROOT/ts/package.json")
  if [ "$have" != "$version" ]; then
    echo "::error::ts/package.json declares version \"$have\", not the requested $version — bump it before cutting ts-v$version" >&2
    exit 1
  fi
  echo "OK — ts/package.json already declares version $version."

  tag="ts-v$version"
  if tag_exists_locally "$tag"; then
    echo "::error::$tag already exists locally. npm rejects a republish of an already-served version, so this version number is spent — bump and retry." >&2
    exit 1
  fi
  remote=$(tag_exists_remotely "$tag")
  case "$remote" in
    yes) echo "::error::$tag already exists on origin. Delete + re-cut is possible ONLY if publish-npm.yml has not yet run for it; if it already published, bump the version instead." >&2; exit 1 ;;
    no)  echo "OK — $tag does not exist locally or on origin." ;;
    unknown) echo "WARNING — could not reach origin to confirm $tag is unclaimed there; local check passed." ;;
  esac

  "$REPO_ROOT/scripts/changelog-hygiene.sh" npm
}

check_java() {
  local version="$1" have tag remote
  have=$(read_java_version "$REPO_ROOT/java/build.gradle.kts")
  if [ "$have" != "$version" ]; then
    echo "::error::java/build.gradle.kts declares version \"$have\", not the requested $version — bump it before cutting java-v$version" >&2
    exit 1
  fi
  echo "OK — java/build.gradle.kts already declares version $version."

  tag="java-v$version"
  if tag_exists_locally "$tag"; then
    echo "::error::$tag already exists locally. Maven Central rejects a republish of an already-served version, so this version number is spent — bump and retry." >&2
    exit 1
  fi
  remote=$(tag_exists_remotely "$tag")
  case "$remote" in
    yes) echo "::error::$tag already exists on origin. Delete + re-cut is possible ONLY if publish-maven.yml has not yet run for it; if it already published, bump the version instead." >&2; exit 1 ;;
    no)  echo "OK — $tag does not exist locally or on origin." ;;
    unknown) echo "WARNING — could not reach origin to confirm $tag is unclaimed there; local check passed." ;;
  esac

  "$REPO_ROOT/scripts/changelog-hygiene.sh" maven
}

main() {
  [ $# -eq 2 ] || die_usage
  case "$1" in
    go)   check_go "$2" ;;
    ts)   check_ts "$2" ;;
    java) check_java "$2" ;;
    *)    die_usage ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
