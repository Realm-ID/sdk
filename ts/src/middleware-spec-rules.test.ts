// SPEC §10.1 step 3 (logout all), §10.5 (originEnforcement, onAuthFailure observe-only), §10.2 (maxAge).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore } from "./session-store.js";
import { AUD, BASE, REALM, drive, fakeIssuer, makeSigner } from "./v063-fixture.test.js";

const NOW = 1_800_000_000;

async function setup(cfg: Record<string, unknown> = {}, policy: "required" | "optional" = "required") {
  const { publicJwk } = await makeSigner();
  const f = fakeIssuer(publicJwk);
  const realm = createRealm({
    realmId: REALM, apiKey: "rk_live_x", baseUrl: BASE, origin: "https://app.test", audience: AUD,
    fetch: f.fetch, clock: () => new Date(NOW * 1000), sessionStore: createMemorySessionStore({ now: () => NOW * 1000 }),
  });
  const r = realm as unknown as {
    info: () => Promise<unknown>;
    origins: { validate: (o: { realmId: string; origin: string }) => Promise<boolean> };
  };
  r.info = async () => ({ id: REALM, audience: AUD, origin_enforcement: policy });
  r.origins.validate = async (o) => o.origin === "https://app.test";
  const mw = realm.middleware({ tokenDelivery: "cookie", exemptPaths: ["/health"], ...cfg } as never);
  return { f, realm, mw };
}

const cookie = (rt: string) => ({ cookie: `realmid_refresh=${rt}` });

test("SPEC10_1_3 logout all:true sends all to the issuer for every candidate", async () => {
  const s = await setup();
  const out = await drive(s.mw as never, { url: "/logout", method: "POST", headers: cookie("rt0"), body: { all: true } });
  assert.equal(out.res.statusCode, 200);
  const calls = s.f.calls.filter((c) => c.url.endsWith("/auth/logout"));
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.equal(c.body["all"], true);
});

test("SPEC10_1_3 logout all other than boolean true is not set", async () => {
  for (const v of [false, "true", 1]) {
    const s = await setup();
    await drive(s.mw as never, { url: "/logout", method: "POST", headers: cookie("rt0"), body: { all: v } });
    const calls = s.f.calls.filter((c) => c.url.endsWith("/auth/logout"));
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.equal(c.body["all"], undefined, `all=${JSON.stringify(v)}`);
  }
});

test("SPEC10_5_observe_only a bearer failure with a hook still writes the 401 envelope", async () => {
  let seen: string | undefined;
  const s = await setup({ onAuthFailure: (_req: unknown, err: { code: string }) => { seen = err.code; } });
  const out = await drive(s.mw as never, { url: "/api/x" });
  assert.equal(seen, "unauthorized", "hook ran");
  assert.equal(out.res.statusCode, 401);
  assert.equal(out.res.json["error"]["code"], "unauthorized");
  assert.equal(out.nextCalled, false);
});

test("SPEC10_5_observe_only a throwing hook does not change the response", async () => {
  const s = await setup({ onAuthFailure: () => { throw new Error("boom"); } });
  const out = await drive(s.mw as never, { url: "/api/x" });
  assert.equal(out.res.statusCode, 401);
  assert.equal(out.res.json["error"]["code"], "unauthorized");
});

test("SPEC10_5_origin_all required realm: foreign Origin is realm_origin_mismatch on login, refresh, mfa verify", async () => {
  for (const url of ["/login", "/token", "/mfa/verify"]) {
    const s = await setup();
    const out = await drive(s.mw as never, { url, method: "POST", headers: { origin: "https://evil.test", ...cookie("rt0") }, body: {} });
    assert.equal(out.res.statusCode, 403, url);
    assert.equal(out.res.json["error"]["code"], "realm_origin_mismatch", url);
    assert.equal(s.f.calls.filter((c) => c.url.endsWith("/auth/login") || c.url.endsWith("/auth/mfa/verify")).length, 0);
  }
});

test("SPEC10_5_origin_all absent Origin is missing_origin; recovery route guarded when configured", async () => {
  const s = await setup({ recoveryPath: "/mfa/recovery" });
  const a = await drive(s.mw as never, { url: "/login", method: "POST", headers: {}, body: {} });
  assert.equal(a.res.statusCode, 403);
  assert.equal(a.res.json["error"]["code"], "missing_origin");
  const b = await drive(s.mw as never, { url: "/mfa/recovery", method: "POST", headers: { origin: "https://evil.test" }, body: {} });
  assert.equal(b.res.json["error"]["code"], "realm_origin_mismatch");
});

test("SPEC10_5_origin_all unreadable allowlist is 502 server_error; logout is not guarded", async () => {
  const s = await setup();
  (s.realm as unknown as { origins: { validate: () => Promise<boolean> } }).origins.validate = async () => { throw new Error("down"); };
  const a = await drive(s.mw as never, { url: "/login", method: "POST", headers: { origin: "https://app.test" }, body: {} });
  assert.equal(a.res.statusCode, 502);
  assert.equal(a.res.json["error"]["code"], "server_error");
  const l = await drive(s.mw as never, { url: "/logout", method: "POST", headers: cookie("rt0"), body: {} });
  assert.equal(l.res.statusCode, 200);
});

test("SPEC10_5_origin_all onAuthFailure sees an origin refusal and the envelope is still written", async () => {
  let n = 0;
  const s = await setup({ onAuthFailure: () => { n++; } });
  const out = await drive(s.mw as never, { url: "/login", method: "POST", headers: { origin: "https://evil.test" }, body: {} });
  assert.equal(n, 1);
  assert.equal(out.res.json["error"]["code"], "realm_origin_mismatch");
});

test("SPEC10_5_origin_all modes: auto follows policy, off never enforces, on enforces regardless; auto fails open on discovery error", async () => {
  const evil = { origin: "https://evil.test" };
  const opt = await setup({}, "optional");
  assert.notEqual((await drive(opt.mw as never, { url: "/login", method: "POST", headers: evil, body: {} })).res.json["error"]?.["code"], "realm_origin_mismatch");
  const off = await setup({ originEnforcement: "off" });
  assert.notEqual((await drive(off.mw as never, { url: "/login", method: "POST", headers: evil, body: {} })).res.json["error"]?.["code"], "realm_origin_mismatch");
  const on = await setup({ originEnforcement: "on" }, "optional");
  assert.equal((await drive(on.mw as never, { url: "/login", method: "POST", headers: evil, body: {} })).res.json["error"]["code"], "realm_origin_mismatch");
  const fo = await setup();
  (fo.realm as unknown as { info: () => Promise<unknown> }).info = async () => { throw new Error("down"); };
  assert.notEqual((await drive(fo.mw as never, { url: "/login", method: "POST", headers: evil, body: {} })).res.json["error"]?.["code"], "realm_origin_mismatch");
});

test("SPEC10_2 a non-finite or negative maxAge is refused at construction", async () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const s = await setup();
    assert.throws(() => s.realm.middleware({ mfaDefaultMaxAgeSeconds: bad } as never), /maxAge/i, `default ${bad}`);
    assert.throws(() => s.realm.middleware({ mfaProtectedPaths: [{ path: "/a", maxAgeSeconds: bad }] } as never), /maxAge/i, `rule ${bad}`);
  }
  const s = await setup();
  assert.doesNotThrow(() => s.realm.middleware({ mfaProtectedPaths: [{ path: "/a", maxAgeSeconds: 0 }] } as never));
});
