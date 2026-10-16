// The error predicates must be importable from the package entry point, not only
// from ./errors.js (parity with Go's IsUserSuspended/IsEscortSuspended/IsTenantDisabled).
import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "./index.js";

test("index exports the 403 predicates", () => {
  const e = (code: string) => new sdk.RealmError({ code: code as never, message: "x" });
  assert.equal(sdk.isUserSuspended(e("user_suspended")), true);
  assert.equal(sdk.isEscortSuspended(e("escort_suspended")), true);
  assert.equal(sdk.isTenantDisabled(e("tenant_disabled")), true);
  assert.equal(sdk.isTenantDisabled(e("forbidden")), false);
});
