import { test } from "node:test";
import { strict as assert } from "node:assert";
import { FakeIssuer, jsonReply, TEST_REALM } from "./split-testutil.test.js";

// SPEC14_11_create_org (R67.1, R83): create-org is a no-actor call that takes the owner and
// returns it seated at role `owner`. Likely green today (the typed create already forwards the
// owner): it guards the wire against the escort rewrite.
test("create-org: owner inline, no actor, returned seated as owner", async () => {
  const f = new FakeIssuer();
  const path = `/platforms/${TEST_REALM}/tenants`;
  f.on(path, () => jsonReply(201, {
    id: "t9", display_name: "Acme", owner_user_id: "u9", owner: { id: "u9", email: "o@acme.test", role: "owner" },
  }));
  const got = await f.realm().tenants.create({ displayName: "Acme", owner: { email: "o@acme.test" } });
  const rs = f.reqs(path);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.auth, "Bearer ptok");
  assert.equal(rs[0]!.userToken, "", "create-org must carry no X-User-Token (R67.1)");
  assert.equal(rs[0]!.body?.owner?.email, "o@acme.test", "owner not sent inline");
  assert.equal("role" in (rs[0]!.body?.owner ?? {}), false, "owner carries a role field; the issuer seats `owner` itself (R83)");
  assert.equal(got.owner_user_id, "u9");
  assert.equal(got.owner?.id, "u9");
  assert.equal(got.owner?.role, "owner", "returned tenant does not show the owner seated at role owner");
});
