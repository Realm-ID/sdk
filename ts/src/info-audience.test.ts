import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InfoClient } from "./info.js";
import type { HttpClient } from "./http.js";

const REALM = "realm_1";

function client(row: object, clock = { t: 1_000_000 }) {
  let calls = 0;
  const http = {
    request: async () => {
      calls++;
      return { data: [row] };
    },
  } as unknown as HttpClient;
  return { info: new InfoClient(http, REALM, () => clock.t), calls: () => calls, clock };
}

for (const [name, row] of Object.entries({
  absent: { id: REALM, domain: "acme.test" },
  null: { id: REALM, audience: null, domain: "acme.test" },
  empty: { id: REALM, audience: "", domain: "acme.test" },
})) {
  test(`a row with ${name} audience is a failed discovery, never the domain`, async () => {
    const c = client(row);
    const got = await c.info.get();
    assert.equal(got.audience, "");
    assert.equal(got.domain, undefined);
    c.clock.t += 31_000;
    await c.info.get();
    assert.equal(c.calls(), 2, "not cached: retried after the window");
  });
}

test("a row with an audience is returned and cached", async () => {
  const c = client({ id: REALM, audience: "realmid:abc", domain: "acme.test" });
  assert.equal((await c.info.get()).audience, "realmid:abc");
  await c.info.get();
  assert.equal(c.calls(), 1);
});
