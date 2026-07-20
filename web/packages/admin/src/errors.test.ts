import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RealmError } from "@realm-id/sdk";
import { CONTACT_ADMIN_REQUIRED, isContactAdminRequired } from "./errors.js";

describe("isContactAdminRequired (ADR-080)", () => {
  it("matches when the raw server code is stashed under details.server_code", async () => {
    // The transport maps the unknown code to conflict + preserves server_code.
    const err = new RealmError({
      code: "conflict",
      message: "contact managed by your org",
      httpStatus: 409,
      details: { server_code: CONTACT_ADMIN_REQUIRED },
    });
    assert.equal(isContactAdminRequired(err), true);
  });

  it("matches when .code itself carries the value (future-union case)", async () => {
    const err = new RealmError({
      code: CONTACT_ADMIN_REQUIRED as unknown as RealmError["code"],
      message: "x",
      httpStatus: 409,
    });
    assert.equal(isContactAdminRequired(err), true);
  });

  it("is false for an unrelated RealmError", async () => {
    const err = new RealmError({ code: "conflict", message: "x", httpStatus: 409 });
    assert.equal(isContactAdminRequired(err), false);
  });

  it("is false for a non-RealmError value", async () => {
    assert.equal(isContactAdminRequired(new Error("nope")), false);
    assert.equal(isContactAdminRequired(null), false);
    assert.equal(isContactAdminRequired({ code: CONTACT_ADMIN_REQUIRED }), false);
  });
});
