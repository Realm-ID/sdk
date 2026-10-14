# RealmID plugin for Claude Code

A Claude Code plugin for teams integrating with RealmID. It adds one skill,
`realmid-integration`, so your own Claude Code sessions follow RealmID's rules when they write
or review integration code.

## Install

In Claude Code:

```
/plugin marketplace add Realm-ID/sdk
/plugin install realmid@realmid
```

(The marketplace is named `realmid` and so is the plugin, hence `realmid@realmid`.)

## What the skill does

It loads when you are integrating with or migrating to RealmID, importing users, verifying
tokens, choosing ids or keys, or designing authorization around RealmID. It tells Claude to:

- key people on `(tenant_id, sub)`, never on email;
- use UUIDs for user and organisation ids (bring your own, or derive a UUIDv5 from a slug);
- keep product authorization in your own `scope` / `product_roles`, since RealmID owns the role set;
- set `scope` only from your backend, never from the browser;
- verify tokens through one issuer abstraction (the SDK), not Google in every service;
- use user API keys in CI.

Each rule links to its entry in the
[FAQ](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md). The skill also
carries offline copies of the FAQ and the
[error reference](https://github.com/Realm-ID/sdk/blob/main/docs/error-reference.md) under
`skills/realmid-integration/references/`.

## Maintainers

The two reference files are generated; never edit them. After changing
`docs/migrating-to-realmid.md` or `docs/error-reference.md`, run
`python3 claude-plugin/scripts/sync-references.py`. `make check` runs the same script with
`--check` and fails if a copy is stale.
