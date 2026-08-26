#!/usr/bin/env bash
# Tag hygiene for the Go SDK's release tags.
#
# The Go SDK publishes by TAG PUSH alone — proxy.golang.org serves
# github.com/Realm-ID/sdk/go@vX.Y.Z straight from `go/vX.Y.Z`. So the tag is not
# a label on the release, it IS the release, and two properties that are merely
# tidy elsewhere are load-bearing here:
#
#   annotated  — a lightweight tag is a branch-like ref. Nothing about it
#                records who cut it or when, and `git push --force` moves it
#                without a trace.
#   immutable  — once the proxy (or any downstream `go.sum`) has seen a version,
#                its content hash is fixed FOREVER in sum.golang.org. Moving the
#                tag afterwards does not republish; it makes every consumer's
#                verification fail with `checksum mismatch`.
#
# That is not hypothetical: `go/v0.21.0` was a lightweight tag, re-pointed on
# GitHub after the proxy had cached the original tree, and the `GOPROXY=direct`
# smoke build broke on exactly that mismatch (RCA: DECISIONS.md 2026-07-05).
# The remedy was written down and enforced by nothing — and the tree shows what
# that is worth: at the time this script was added, 22 of 41 `go/v*` tags were
# lightweight, including the three most recent releases.
#
# ⚠️ ORDERING. Both checks run at TAG-PUSH time, which is AFTER the tag exists.
# When one goes red the remedy is NEVER to re-point or delete the tag — by then
# the damage this guards against is precisely what re-pointing causes. The
# remedy is always to ship the NEXT PATCH VERSION.
#
# Usage:
#   tag-hygiene.sh annotated            <tag>   e.g. go/v0.45.0
#   tag-hygiene.sh annotated-prepublish <tag>   e.g. ts-v0.37.0
#   tag-hygiene.sh go-immutable         <tag>
#   tag-hygiene.sh unreleased-go                (no tag argument)
#
# The two annotation modes differ ONLY in the remedy they print, and the
# difference is real. For `go/v*` the tag IS the release — by the time anything
# runs, the proxy may already have served it, so the remedy is the next patch
# version and NEVER a re-point. For `ts-v*` / `java-v*` the tag merely TRIGGERS
# a publish to npm / Maven Central; running this before the publish step means
# nothing has been released yet, so deleting the tag and re-cutting it annotated
# is both safe and correct. Printing the Go remedy there would send an operator
# to burn a version number for no reason.
#
# `unreleased-go` is the only check here that can PREVENT rather than report.
# Both tag checks run after the tag exists; this one runs on main/PR and refuses
# a content change under a version number that has already been released, which
# is the root shape of the 2026-07-05 incident (a tree changed, the version did
# not, and the fix was to move the tag). Its cost is a policy: after a release,
# the first PR to touch go/ must bump the const. That is deliberate — the bump
# is the thing that was being skipped.
#
# Exit 0 = pass, 1 = violation, 2 = usage/environment error.

set -euo pipefail

MODULE_PATH='github.com/Realm-ID/sdk/go'
# The checksum DB keys modules by their ESCAPED path: each uppercase letter is
# replaced by '!' plus its lowercase form, so Realm-ID becomes !realm-!i!d.
MODULE_ESCAPED='github.com/!realm-!i!d/sdk/go'

die_usage() { echo "usage: $0 {annotated|annotated-prepublish|go-immutable} <tag>" >&2; exit 2; }

# Emit to stdout and, when running under Actions, to the job summary.
say() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

require_tag() {
  if ! git rev-parse -q --verify "refs/tags/$1" >/dev/null; then
    echo "::error::tag '$1' not found locally — checkout needs fetch-depth: 0 and tags" >&2
    exit 2
  fi
}

check_annotated() {
  local tag="$1" mode="${2:-released}" kind
  require_tag "$tag"
  # An annotated tag's ref resolves to a `tag` OBJECT; a lightweight one points
  # straight at the commit. This is the only difference, and it is the one that
  # decides whether the tag carries an author, a date and a message at all.
  kind=$(git cat-file -t "refs/tags/$tag")
  if [ "$kind" = "tag" ]; then
    say "OK — \`$tag\` is an annotated tag."
    return 0
  fi
  say "**LIGHTWEIGHT TAG.** \`$tag\` points straight at a commit ($kind), so it"
  say "carries no tagger, no date and no message, and a force-push would move it"
  say "silently."
  say ""
  if [ "$mode" = "prepublish" ]; then
    say "This ran BEFORE the publish step, so **nothing has been released yet** and"
    say "the tag is still yours to fix:"
    say ""
    say '```'
    say "git tag -d $tag && git push origin :refs/tags/$tag"
    say "git tag -a $tag -m \"$tag\" && git push origin $tag"
    say '```'
    say ""
    say "(If a previous run of this workflow already published, do NOT delete the"
    say "tag — the registry copy is immutable. Ship the next patch version.)"
  else
    say "**Do not delete or re-point \`$tag\`** — if the module proxy has already"
    say "served it, moving it is what breaks every downstream \`go.sum\`. Cut the"
    say "NEXT PATCH VERSION with \`git tag -a\` instead."
  fi
  echo "::error::$tag is a lightweight tag; release tags must be annotated (git tag -a)"
  return 1
}

check_go_immutable() {
  local tag="$1" version lookup http recorded local_sum probe
  require_tag "$tag"
  case "$tag" in
    go/v*) version="${tag#go/}" ;;
    *) echo "::error::go-immutable only applies to go/v* tags, got '$tag'" >&2; exit 2 ;;
  esac

  # sum.golang.org is an append-only, signed log. If it already holds a hash for
  # this version then this version was published before, and that hash can never
  # change — so the tree the tag points at NOW must still hash to it.
  lookup=$(mktemp)
  http=$(curl -sS -o "$lookup" -w '%{http_code}' \
    "https://sum.golang.org/lookup/${MODULE_ESCAPED}@${version}" || echo 000)

  if [ "$http" = "404" ] || [ "$http" = "410" ]; then
    say "OK — \`$version\` is not in sum.golang.org yet, so this is its first"
    say "publication and there is nothing it can contradict."
    rm -f "$lookup"
    return 0
  fi
  if [ "$http" != "200" ]; then
    echo "::error::sum.golang.org lookup for $version returned HTTP $http" >&2
    cat "$lookup" >&2 || true
    rm -f "$lookup"
    exit 2
  fi

  # The module hash is the line WITHOUT the /go.mod suffix.
  recorded=$(awk -v m="$MODULE_PATH" -v v="$version" \
    '$1==m && $2==v {print $3}' "$lookup")
  rm -f "$lookup"
  if [ -z "$recorded" ]; then
    echo "::error::could not parse a module hash for $MODULE_PATH $version out of the sumdb response" >&2
    exit 2
  fi

  # Hash the tree the tag points at right now. GOMODCACHE is deliberately a
  # FRESH directory: a warm cache could still hold the pre-re-point zip for this
  # exact version, and comparing a stale cache against the sumdb would agree for
  # the wrong reason — a false PASS on the one input this check exists to catch.
  probe=$(mktemp -d)
  (
    cd "$probe"
    go mod init tag-hygiene-probe >/dev/null
    GOMODCACHE="$probe/modcache" GOFLAGS=-mod=mod GOPROXY=direct GOSUMDB=off GONOSUMDB='*' GOPRIVATE='*' \
      go mod download -json "${MODULE_PATH}@${version}" > download.json
  )
  local_sum=$(sed -n 's/.*"Sum": "\([^"]*\)".*/\1/p' "$probe/download.json" | head -1)
  # The Go module cache is written READ-ONLY, so a bare `rm -rf` exits non-zero
  # and, under `set -e`, aborts this function BEFORE the comparison below — the
  # guard failed during housekeeping and never ran its own assertion. Make the
  # tree writable first, and never let cleanup decide the verdict.
  chmod -R u+w "$probe" 2>/dev/null || true
  rm -rf "$probe" || true
  if [ -z "$local_sum" ]; then
    echo "::error::go mod download did not report a Sum for ${MODULE_PATH}@${version}" >&2
    exit 2
  fi

  if [ "$local_sum" = "$recorded" ]; then
    say "OK — \`$version\` is already in sum.golang.org and the tag still hashes"
    say "to the recorded value (\`$recorded\`). Re-running this job is safe."
    return 0
  fi

  say "**TAG RE-POINTED AFTER PUBLICATION.** \`$tag\` no longer matches what"
  say "sum.golang.org permanently recorded for \`$version\`:"
  say ""
  say "| | |"
  say "|---|---|"
  say "| sum.golang.org has | \`$recorded\` |"
  say "| the tag hashes to  | \`$local_sum\` |"
  say ""
  say "Every consumer that already has the old hash in \`go.sum\` now fails with"
  say "\`checksum mismatch\` — this is the \`go/v0.21.0\` incident (DECISIONS.md"
  say "2026-07-05) happening again."
  say ""
  say "**There is no way to fix \`$version\`.** The log is append-only. Restore"
  say "the tag to the published commit if you can, and ship the change as the"
  say "NEXT PATCH VERSION."
  echo "::error::$tag hashes to $local_sum but sum.golang.org recorded $recorded for $version"
  return 1
}

check_unreleased_go() {
  local version tag
  local n
  n=$(grep -c '^const Version = "' go/realmid.go || true)
  if [ "$n" != "1" ]; then
    echo "::error::expected exactly 1 'const Version =' declaration in go/realmid.go, found $n" >&2
    exit 2
  fi
  version=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' go/realmid.go)
  tag="go/v$version"

  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    say "OK — \`$version\` has no \`$tag\` tag yet, so nothing under it is"
    say "released and \`go/\` may change freely."
    return 0
  fi

  if git diff --quiet "refs/tags/$tag" HEAD -- go/; then
    say "OK — \`go/\` is identical to the released \`$tag\`."
    return 0
  fi

  say "**\`go/\` HAS CHANGED UNDER A RELEASED VERSION.** \`go/realmid.go\` still"
  say "declares \`Version = \"$version\"\`, but \`$tag\` is already tagged and its"
  say "tree differs from this one:"
  say ""
  say '```'
  git diff --stat "refs/tags/$tag" HEAD -- go/ | sed 's/^/    /' | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  say '```'
  say ""
  say "Two different trees would answer to one version. If \`$tag\` were re-pointed"
  say "to pick this up, every consumer holding the old hash in \`go.sum\` breaks"
  say "with \`checksum mismatch\` — that is the 2026-07-05 incident."
  say ""
  say "**Bump \`const Version\` in \`go/realmid.go\` before merging.** This check"
  say "exists to make that a build failure rather than something to remember."
  echo "::error::go/ differs from released tag $tag while const Version is still $version — bump the version"
  return 1
}

case "${1:-}" in
  unreleased-go) [ $# -eq 1 ] || die_usage; check_unreleased_go; exit $? ;;
esac

[ $# -eq 2 ] || die_usage
case "$1" in
  annotated)            check_annotated "$2" ;;
  annotated-prepublish) check_annotated "$2" prepublish ;;
  go-immutable)         check_go_immutable "$2" ;;
  *)                    die_usage ;;
esac
