import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createIntegrationTokenHandler, createSplitRealm } from "./split.js";
import { SplitKey, FakeIssuer, MemShares, jsonReply, userClaims, verifyRS256, fromB64u, TEST_REALM } from "./split-testutil.test.js";

// SPEC14_8_integration (R47, R50, R67.2). The inbound shape {"pass": "..."} is [inferred]. The
// handler is a fetch-style (Request) => Response function. Go rate-limits per RemoteAddr; a Request
// has none, so the ts key is S6's call (these tests use one caller, so any key works).

const post = (h: (r: Request) => Promise<Response>, pass?: string): Promise<Response> =>
  h(new Request("https://target.example/realmid/integration-token", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pass === undefined ? {} : { pass }),
  }));

const installMints = (f: FakeIssuer) => f.reqs("/auth/token").filter((r) => r.body?.grant_type === "integration_installation");

test("integration-handler: forwards the pass in X-User-Token with the target's platform token", async () => {
  const f = new FakeIssuer();
  f.on("/auth/token", () => jsonReply(200, { access_token: "TARGET-AT", expires_in: 600, tenant_id: "t1", role: "member" }));
  const res = await post(createIntegrationTokenHandler(f.realm()), "ip_abc");
  const mints = installMints(f);
  assert.equal(mints.length, 1, `no integration_installation mint reached /auth/token; handler answered ${res.status}`);
  assert.equal(mints[0]!.auth, "Bearer ptok");
  assert.equal(mints[0]!.userToken, "ip_abc", "the pass must ride in X-User-Token");
  for (const [k, v] of Object.entries(mints[0]!.body ?? {})) {
    assert.equal(typeof v === "string" && v.includes("ip_abc"), false, `pass leaked into body field ${k} (R67.2: header only)`);
  }
  assert.equal(f.reqs("/auth/token/partial").length, 0, "a full target hit /auth/token/partial");
});

test("integration-handler: a full target relays the issuer's answer verbatim", async () => {
  const f = new FakeIssuer();
  f.on("/auth/token", () => jsonReply(401, { error: { code: "install_pass_invalid", message: "spent" } }));
  const res = await post(createIntegrationTokenHandler(f.realm()), "ip_spent");
  const text = await res.text();
  assert.equal(res.status, 401, `got ${res.status} ${text}`);
  assert.match(text, /install_pass_invalid/);
});

test("integration-handler: a split target finishes the half-signed answer", async () => {
  const k = await SplitKey.make("split-1");
  const f = new FakeIssuer();
  f.on("/auth/token/partial", async () => jsonReply(200, await k.partialAnswer(userClaims(f.issuer))));
  const realm = createSplitRealm({ ...f.cfg(), shareSource: new MemShares(k.bundle(TEST_REALM)) });
  const res = await post(createIntegrationTokenHandler(realm), "ip_abc");
  const out = (await res.json()) as { access_token?: string };
  assert.ok(out.access_token, `split target answered ${res.status} without an access_token`);
  const parts = out.access_token!.split(".");
  assert.equal(parts.length, 3, "unfinished token");
  assert.ok(await verifyRS256(k.n, k.e, `${parts[0]}.${parts[1]}`, fromB64u(parts[2]!)), "unverifiable token");
  const pr = f.reqs("/auth/token/partial");
  assert.equal(pr.length, 1);
  assert.equal(pr[0]!.userToken, "ip_abc");
  assert.equal(pr[0]!.auth, "Bearer ptok");
});

test("integration-handler: rate limits before calling the issuer", async () => {
  const f = new FakeIssuer();
  f.on("/auth/token", () => jsonReply(200, { access_token: "AT", expires_in: 600 }));
  const h = createIntegrationTokenHandler(f.realm(), { ratePerMinute: 2 });
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) codes.push((await post(h, "ip_a")).status);
  assert.deepEqual(codes, [200, 200, 429, 429]);
  assert.equal(installMints(f).length, 2, "limited requests must not reach the issuer");
});

test("integration-handler: rejects a non-POST and a missing pass without calling the issuer", async () => {
  const f = new FakeIssuer();
  const h = createIntegrationTokenHandler(f.realm());
  assert.equal((await h(new Request("https://target.example/x", { method: "GET" }))).status, 405);
  assert.equal((await post(h)).status, 400);
  assert.equal(installMints(f).length, 0, "issuer called for a request with no pass");
});
