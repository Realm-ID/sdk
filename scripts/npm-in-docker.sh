#!/usr/bin/env bash
# Run an npm command for one JS package IN DOCKER without clobbering the host
# node_modules.
#
# THE FAULT THIS EXISTS FOR: on 2026-08-24 `sdk/ts`'s host node_modules ended up
# holding ONLY `@esbuild/linux-arm64`, so a macOS `npm test` died on
# "You installed esbuild for another platform" — 0 pass / 30 fail on a clean
# tree, which reads as a broken suite rather than a broken install.
#
# The cause was NOT the compose stack. `tests/docker-compose.test.yml`'s
# `sdk-e2e-ts` service has shadowed `/work/sdk/ts/node_modules` with a named
# volume since the commit that introduced it (`dbeeb75`), and its comment names
# this exact hazard. What wrote the linux tree was the ad-hoc recipe people
# reach for when there is no compose service — a bare
#
#     docker run --rm -v "$(pwd)":/w -w /w node:22-alpine npm ci && npm test
#
# which bind-mounts the package with NO shadow, so the container's linux
# install lands on the host tree. The workaround broke the thing it was working
# around, and it was written down as the remedy.
#
# So the shadow cannot live only in compose: it has to live wherever an npm
# command meets a bind mount. This is that place.
#
# Usage:  scripts/npm-in-docker.sh <package-dir> [npm args...]
#   e.g.  scripts/npm-in-docker.sh ts test
#         scripts/npm-in-docker.sh ts run typecheck
#
# `npm ci` runs first, into the shadow volume. The volume is per-package and
# persists, so repeat runs skip the download; `docker volume rm` it to reset.
#
# SELF-CONTAINED PACKAGES ONLY — `ts`, today. The `web` tree is an npm WORKSPACE:
# its deps hoist to `web/node_modules` and `@realm-id/sdk` is a symlink to
# `../../../ts`, OUTSIDE any mount this script makes. Measured rather than
# assumed: `web` as a target gets `ENOENT /ts/package.json` on web-admin's
# pretest, then npm carries on and runs the OTHER three workspaces before
# exiting 254 — a partial run with a non-zero code, which is exactly the shape
# that gets skimmed as "some noise but it passed". So both are REFUSED below.
# Run the web tree on the host: it needs no native binaries (the esbuild hazard
# is `ts`'s, via tsx).
set -euo pipefail

readonly NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}"
readonly SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ $# -lt 1 ]; then
  echo "usage: $(basename "$0") <package-dir> [npm args...]" >&2
  echo "  e.g. $(basename "$0") ts test" >&2
  exit 2
fi

pkg="$1"
shift

pkg_dir="$SDK_ROOT/$pkg"
if [ ! -f "$pkg_dir/package.json" ]; then
  echo "error: no package.json under $pkg_dir" >&2
  exit 2
fi

# Refuse the workspace tree rather than half-running it. See the header: a
# workspace member's deps live above the mount, so `npm ci` cannot resolve them
# and npm reports the failure while still running everything else.
if grep -q '"workspaces"' "$pkg_dir/package.json" 2>/dev/null; then
  echo "error: $pkg is an npm workspace ROOT — its members' deps hoist above any mount" >&2
  echo "       this script makes. Run it on the host: (cd $pkg && npm test)" >&2
  exit 2
fi
if [ -f "$pkg_dir/../../package.json" ] && grep -q '"workspaces"' "$pkg_dir/../../package.json" 2>/dev/null; then
  echo "error: $pkg is an npm workspace MEMBER; its deps hoist to the workspace root," >&2
  echo "       outside this script's mount. Run it on the host: (cd $pkg && npm test)" >&2
  exit 2
fi

# One volume per package.
vol="realmid_sdk_node_$(printf '%s' "$pkg" | tr '/' '_')"

echo "==> $NODE_IMAGE :: npm ci && npm $* (in $pkg, node_modules shadowed by $vol)"

exec docker run --rm -t \
  -v "$pkg_dir":/w \
  -v "$vol":/w/node_modules \
  -w /w \
  "$NODE_IMAGE" \
  sh -euc 'npm ci --no-audit --no-fund; exec npm "$@"' -- "$@"
