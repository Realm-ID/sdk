---
name: realmid-integration
description: Rules for integrating an app with RealmID (sign-in, organisations, tokens). Use when the user is integrating with or migrating to RealmID, importing users, verifying RealmID tokens, choosing ids or database keys for people and organisations, or designing roles and authorization around RealmID.
---

# RealmID integration rules

Apply these when writing or reviewing code that touches RealmID. Each rule cites the public
FAQ entry that states it. The full FAQ is in `references/migrating-to-realmid.md` and every
error code is in `references/error-reference.md` (both are copies; the links below are the
canonical pages). If a rule here and the served OpenAPI spec
(https://auth.realmid.dev/.well-known/openapi.json) disagree, the spec wins.

## Rules

1. **Key people on `(tenant_id, sub)`, never on email.** `sub` is the id of a person's
   membership in ONE organisation, not a person id and not Google's id. A person in three
   organisations has three `sub` values. Email is only a way to look someone up, never a
   primary key or an authorization decision. If you need "same human", use your own person id.
   - [`sub`](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#what-is-sub-and-what-should-i-store-per-person)
   - [email](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#why-not-key-people-on-their-email)
   - [one person, many organisations](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#can-one-person-belong-to-many-organisations)

2. **User and organisation ids are UUIDs.** You may bring your own (bulk import `user_id`
   becomes the `sub`; `POST /platforms/{pid}/tenants` accepts an optional `id`). A non-UUID
   cannot be imported. If you have slugs, derive a UUIDv5 from the slug with a namespace you
   choose once and never change; one id is one membership, so put the organisation in the
   hash for user ids.
   - [user ids](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#can-i-bring-my-own-user-ids)
   - [organisation ids](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#can-i-bring-my-own-organisation-tenant-ids)
   - [slugs to UUIDv5](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#my-ids-look-like-ten-glowbar-what-do-i-do)

3. **RealmID owns the role set; your product authorization is yours.** The `role` claim
   (`owner`, `admin`, `member`) controls what a person may do to RealmID, and you cannot add
   roles. Keep your own product roles in your own database as the source of truth, and put
   them on the token only via `scope` and/or `product_roles`. Do not hard-code RealmID role
   names; read them from `GET /platforms/{id}/roles`.
   - [who owns roles](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#who-owns-roles-realmid-or-me)
   - [adding roles](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#can-i-add-my-own-roles-to-realmid)
   - [roles on the token](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#how-do-my-own-roles-get-onto-the-token)

4. **Set `scope` only from your backend.** Your confidential backend requests `scope` and
   `product_roles` when it mints on `POST /auth/token`. Never forward a browser-supplied role
   or scope list into the mint, and never let the browser hold the refresh token. RealmID does
   not filter scope strings, so your backend is the filter: request only what the person
   should have.
   - [browser-supplied roles](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#can-a-browser-ask-for-its-own-roles-or-scopes)
   - [scope is not filtered](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#does-realmid-drop-scopes-it-does-not-recognise)

5. **Verify tokens through ONE issuer abstraction.** Configure a single verifier with
   (issuer, key-set URL, audience), use the RealmID SDK for it, and have every service call
   that one function. Do not verify Google tokens separately in each service. Verify
   signature, `iss` and `aud` on every request.
   - [what to avoid now](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#what-should-i-avoid-doing-now-because-it-breaks-later)
   - [what is in a token](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#what-is-in-a-realmid-access-token)

6. **CI uses user API keys.** There is no "test user" sign-in. Mint a user API key for a test
   person from your backend, store it as a CI secret, and exchange it with `POST /auth/login`
   and `grant_type: "user_api_key"`. It expires, so plan rotation.
   - [CI tokens](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#how-does-my-ci-get-a-user-token-without-an-interactive-google-sign-in)

## Also true (easy to get wrong)

- RealmID mints access and refresh tokens only: no `/authorize` redirect login and no ID
  token. Your backend signs users in with `POST /auth/login`; the browser never calls it.
  [details](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#does-realmid-issue-an-oidc-id-token-or-run-a-redirect-authorize-login-page-for-my-app)
- After migrating, `sub` is RealmID's membership id, not Google's subject; grep every place
  you log, cache or join on `sub`.
  [details](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#after-i-migrate-what-does-sub-mean)
- Organisations are flat; a project is your own record, not a RealmID organisation.
  [details](https://github.com/Realm-ID/sdk/blob/main/docs/migrating-to-realmid.md#can-a-project-or-any-thing-below-an-organisation-be-a-realmid-organisation)

## When unsure

Read the matching entry in `references/migrating-to-realmid.md`, and look up any error code in
`references/error-reference.md`. If neither answers it, say so rather than guessing; do not
assume RealmID does something the FAQ does not state.
