import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { AssertedIdentity, ContactVerification } from "./index.js";

// Compile-time check (run by `npm run typecheck`): the root entry point re-exports
// `AssertedIdentity`, and `ContactVerification.asserted_identity` is that type.
test("web-admin re-exports AssertedIdentity with its masked fields", () => {
  const id: AssertedIdentity = { email_masked: "k***@example.com", phone_masked: "+44*******123", display_name: "Kay" };
  const row: Pick<ContactVerification, "asserted_identity"> = { asserted_identity: id };
  assert.equal(row.asserted_identity?.email_masked, "k***@example.com");
});
