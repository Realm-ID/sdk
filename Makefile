# Local preflight gates for Realm-ID/sdk.
#
# WHY THIS EXISTS: `CI-FAILURE-AUDIT-2026-09-05.md` (root of the umbrella repo)
# measured 35 of 169 recent runs failing here — the worst share in the
# workspace — and found 86% of ALL cross-repo failures fire on `push`, because
# no local path exists that would have asked the same question first. This
# repo's own top offenders are locally-determinable: `go/ has not changed
# under a released version` (8), a changelog missing its entry (5+3), the three
# error-code taxonomies disagreeing (3), a TypeScript type error (2), gofmt (1).
# None of those need network, secrets or a compose stack.
#
# `check` mirrors `.github/workflows/ci.yml` plus ONE job from
# `workflow-hygiene.yml` (third-party actions are SHA-pinned). That second
# workflow is also required, and until 2026-09-18 nothing local ran it: a CI
# failure audit over the last 60 runs found it was the only failure class no
# local gate could have caught. "check mirrors ci.yml" had been an accurate
# description of a gap rather than a defence of one.
#
# The publish workflows' own gates (tag-hygiene's annotated/go-immutable modes,
# changelog-hygiene's npm/maven/go modes) run at TAG-PUSH time, after which a
# Go tag is already immutable (proxy.golang.org may have served it —
# `go/v0.58.0` is burned this way). `release-check` runs those same assertions
# against the working tree, before any tag exists.
#
# ⚠️ `release-check` is no longer a target you have to REMEMBER. `.githooks/pre-push`
# runs it automatically for a pushed `go/v*` / `ts-v*` / `java-v*` tag, and
# refuses a lightweight one. The same audit found 13 CI failures that a local
# gate already covered and that were pushed anyway — mostly at tag time, because
# the hook only ever saw branch pushes. Prevention is only possible before the
# tag exists; every gate after it can report and nothing more.
#
# Every command below is copied VERBATIM from the workflow step it mirrors —
# see the comment on each target naming its source. If a step's own command
# ever changes, this Makefile drifts silently unless someone updates both; that
# is the acknowledged cost of "replicate minimally" (SPEC's anti-duplication
# rule applies to LISTS and rule sets, not to invoking the same script or the
# same one-line command CI already runs).

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ── help ───────────────────────────────────────────────────────────────────────

.PHONY: help
help:
	@echo "Realm-ID/sdk — local preflight targets"
	@echo ""
	@echo "  make check                       run every cheap CI gate (<60s, no network, no secrets)"
	@echo "  make release-check LANGUAGE=go VERSION=x.y.z    pre-tag gates for one language (go|ts|java)"
	@echo "  make install-hooks                point git at the tracked pre-push hook"
	@echo "  make self-test                    run this repo's own checker-script tests"

# ── check ──────────────────────────────────────────────────────────────────────
#
# Hard rules (SPEC): under 60s, no network, no secrets, no compose stack, no
# integration suite. Runs every gate and reports ALL failures before exiting
# non-zero — never stops at the first. A step that cannot run at all (missing
# local install) is SKIPPED loudly and that counts as a failure unless
# PREFLIGHT_ALLOW_SKIP=1.
#
# java/ is DELIBERATELY NOT HERE. Its CI job (`./gradlew test --no-daemon`)
# resolves dependencies over the network on a cold cache; there is no way to
# tell "cached, so this run is free" from "not cached, so this run is not" in
# under a second without just trying it, and this target's contract is no
# network at all. Run it by hand: `cd java && ./gradlew test --no-daemon`.

.PHONY: check
check:
	@bash scripts/preflight-check.sh

# ── release-check ──────────────────────────────────────────────────────────────
#
# Runs scripts/release-check.sh, which itself reuses changelog-hygiene.sh and
# tag-hygiene.sh rather than re-implementing their logic (SPEC anti-duplication
# rule). See that script's header for why go/ts/java are three separate rules,
# not one flattened check: Go's tag IS the release (immutable the moment
# proxy.golang.org has served it); ts/java publish from a step AFTER the tag
# push, so a bad tag there is merely wasteful, not unrecoverable.
#
# The variable is `LANGUAGE`, deliberately NOT `LANG` — this shell almost
# certainly already exports `LANG` (a locale, e.g. `en_US.UTF-8`), and a
# command-line `make` assignment overrides the environment either way, so
# `make release-check VERSION=x.y.z` with no LANG given would silently read
# the inherited locale string as the language argument instead of failing the
# usage check. Verified against this box's own `LANG=en_IN.UTF-8`.

.PHONY: release-check
release-check:
	@if [ -z "$(LANGUAGE)" ] || [ -z "$(VERSION)" ]; then \
		echo "usage: make release-check LANGUAGE={go|ts|java} VERSION=x.y.z" >&2; \
		exit 2; \
	fi
	@bash scripts/release-check.sh "$(LANGUAGE)" "$(VERSION)"

# ── install-hooks ──────────────────────────────────────────────────────────────

.PHONY: install-hooks
install-hooks:
	git config core.hooksPath .githooks
	@echo "installed: git will now run .githooks/pre-push"

# ── self-test ──────────────────────────────────────────────────────────────────
#
# This repo's checker-owned scripts and their tests. Per the checker-tests
# rule, any NEW verdict-rendering script ships with tests that run before it is
# ever relied on — scripts/release-check.sh is new in this pass, so
# scripts/release-check.test.sh is its test suite. The existing hygiene
# scripts (tag-hygiene.sh, changelog-hygiene.sh, taxonomy-parity.py) predate
# this pass and have no test files of their own; they are exercised directly
# by `make check` against this repo's real tree instead.
#
# scripts/contract-parity.py is the same "new verdict-rendering script" case —
# scripts/contract-parity.test.py is its suite, and it runs here AND again
# (first) as its own gate inside `make check`, since that checker itself runs
# inside `check`, not only via this target.

.PHONY: self-test
self-test:
	@bash scripts/release-check.test.sh
	@python3 scripts/contract-parity.test.py
	@bash scripts/workflow-hygiene.sh --self-test
	@bash scripts/pre-push.test.sh
