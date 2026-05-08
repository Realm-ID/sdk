#!/usr/bin/env bash
# Publishes @realmid/web, @realmid/web-react, @realmid/web-bff-realmid
# to npm. Run from sdk/web/. Requires `npm login` first (or NPM_TOKEN
# env var). Idempotent — npm publish errors with E409 if a version
# already exists, which we treat as a no-op.
#
# Order matters: core first (peers depend on it), then the rest.
set -euo pipefail

cd "$(dirname "$0")/.."

npm whoami || { echo "Run \`npm login\` first." >&2; exit 1; }

publish_one() {
  local pkg=$1
  local tag=${2:-latest}
  echo "==> $pkg"
  (
    cd "packages/$pkg"
    npm run build
    npm publish --access=public --tag="$tag" || {
      ec=$?
      if [ "$ec" -eq 1 ]; then
        echo "($pkg already published at this version — skipping.)"
      else
        exit "$ec"
      fi
    }
  )
}

publish_one core
publish_one react
publish_one bff-realmid

# Skipping firebase + google for now — they were only version-bumped in
# lockstep and have not been re-tested against v0.3 surface changes.
# Add them once we run their integration suites.
#
# publish_one firebase
# publish_one google

echo "Done."
