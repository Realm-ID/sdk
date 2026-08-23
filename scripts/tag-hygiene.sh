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
#   tag-hygiene.sh annotated     <tag>   e.g. go/v0.45.0
#   tag-hygiene.sh go-immutable  <tag>
#
# Exit 0 = pass, 1 = violation, 2 = usage/environment error.

set -euo pipefail

MODULE_PATH='github.com/Realm-ID/sdk/go'
# The checksum DB keys modules by their ESCAPED path: each uppercase letter is
# replaced by '!' plus its lowercase form, so Realm-ID becomes !realm-!i!d.
MODULE_ESCAPED='github.com/!realm-!i!d/sdk/go'

die_usage() { echo "usage: $0 {annotated|go-immutable} <tag>" >&2; exit 2; }

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
  local tag="$1" kind
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
  say "**Do not delete or re-point \`$tag\`** — if the module proxy has already"
  say "served it, moving it is what breaks every downstream \`go.sum\`. Cut the"
  say "NEXT PATCH VERSION with \`git tag -a\` instead."
  echo "::error::$tag is a lightweight tag; go/v* releases must be annotated (git tag -a)"
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
  rm -rf "$probe"
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

[ $# -eq 2 ] || die_usage
case "$1" in
  annotated)    check_annotated "$2" ;;
  go-immutable) check_go_immutable "$2" ;;
  *)            die_usage ;;
esac
