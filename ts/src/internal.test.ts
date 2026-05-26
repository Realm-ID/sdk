import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TenantsClient,
  InvitationsClient,
  UsersClient,
  DriftReviewsClient,
  ContactVerificationsClient,
  RolesClient,
  ApiKeysClient,
  DomainsClient,
  AdminClient,
  OriginsClient,
  HttpClient,
} from "./internal.js";

test("internal entry re-exports resource classes as constructors", () => {
  const classes = {
    TenantsClient,
    InvitationsClient,
    UsersClient,
    DriftReviewsClient,
    ContactVerificationsClient,
    RolesClient,
    ApiKeysClient,
    DomainsClient,
    AdminClient,
    OriginsClient,
    HttpClient,
  };
  for (const [name, ctor] of Object.entries(classes)) {
    assert.equal(typeof ctor, "function", `${name} should be a constructor function`);
  }
});
