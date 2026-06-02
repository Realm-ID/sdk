/**
 * Cross-cut tests that exercise multiple modules at once: Origin
 * auto-attach (SPEC §8), apiKey-required validation (SPEC §1), and
 * Logger redaction across the HTTP path (SPEC §9).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

const REALM_ID = "01HREALM";
const API_KEY = "rk_live_supersecret";

function mkFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): { fetch: typeof fetch; calls: Array<{ url: string; headers: Headers; body: unknown }> } {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = init.body; }
    }
    calls.push({ url, headers, body });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch, calls };
}

test("createRealm: missing apiKey is allowed (auto-detect workload identity, ADR-057)", () => {
  // No apiKey + no credential → auto-detect an ambient workload identity.
  // Construction succeeds; the credential is only fetched lazily at first
  // login (which is what would fail off a supported platform).
  const realm = createRealm({ realmId: REALM_ID });
  assert.equal(realm.realmId, REALM_ID);
  // realmId is still required.
  assert.throws(() => createRealm({} as Parameters<typeof createRealm>[0]), (e: Error) => {
    return e instanceof RealmError && e.code === "bad_request" && /realmId/.test(e.message);
  });
});

test("Origin auto-attach: derived from realm.info() audience when no override", async () => {
  const { fetch, calls } = mkFetch((url, init) => {
    if (url.endsWith("/auth/login")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.grant_type === "platform_api_key") {
        return new Response(JSON.stringify({
          status: "ok", subject_type: "platform",
          refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: "at", refresh_token: "rt", expires_in: 900,
        user: { id: "u1" }, tenants: [],
      }), { status: 200 });
    }
    if (url.endsWith("/platforms/mine")) {
      return new Response(JSON.stringify([{ id: REALM_ID, audience: "acme.com" }]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  await realm.auth.login({ method: "firebase", providerToken: "id" });
  // The user-grant /auth/login is the call carrying the Origin header
  // (the platform-api-key bootstrap doesn't).
  const loginCall = calls.find((c) => {
    if (!c.url.endsWith("/auth/login")) return false;
    return c.body && (c.body as { grant_type?: string }).grant_type !== "platform_api_key";
  });
  assert.ok(loginCall, "expected user-grant /auth/login call");
  assert.equal(loginCall!.headers.get("origin"), "https://acme.com");
});

test("Origin auto-attach: per-call origin overrides handle config and discovery", async () => {
  const { fetch, calls } = mkFetch((url, init) => {
    if (url.endsWith("/auth/login")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.grant_type === "platform_api_key") {
        return new Response(JSON.stringify({
          status: "ok", subject_type: "platform",
          refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: "at", refresh_token: "rt", expires_in: 900,
        user: { id: "u1" }, tenants: [],
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const realm = createRealm({
    realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test",
    fetch, origin: "https://configured.example",
  });
  await realm.auth.login({ method: "firebase", providerToken: "id", origin: "https://percall.example" });
  const loginCall = calls.find((c) => {
    if (!c.url.endsWith("/auth/login")) return false;
    return c.body && (c.body as { grant_type?: string }).grant_type !== "platform_api_key";
  });
  assert.equal(loginCall!.headers.get("origin"), "https://percall.example");
});

test("Logger: never logs raw apiKey, platform_token, refresh, or access tokens", async () => {
  const captured: string[] = [];
  const stash = (msg: string, meta?: Record<string, unknown>) => {
    captured.push(JSON.stringify({ msg, meta }));
  };
  const logger = { debug: stash, info: stash, warn: stash, error: stash };

  const { fetch } = mkFetch((url, init) => {
    if (url.endsWith("/auth/login")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.grant_type === "platform_api_key") {
        return new Response(JSON.stringify({
          status: "ok", subject_type: "platform",
          refresh_token: "rtok-platform", access_token: "pt_topsecret_full", expires_in: 300,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: "at_topsecret_access",
        refresh_token: "rt_topsecret_refresh",
        expires_in: 900, user: { id: "u1" }, tenants: [],
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  const realm = createRealm({
    realmId: REALM_ID, apiKey: "rk_live_supersecret_full", baseUrl: "https://auth.test",
    fetch, logger, origin: "https://app.test",
  });
  await realm.auth.login({ method: "firebase", providerToken: "providertok_full" });

  const all = captured.join("\n");
  for (const secret of [
    "supersecret_full",
    "topsecret_full",
    "topsecret_access",
    "topsecret_refresh",
    "providertok_full",
  ]) {
    assert.ok(!all.includes(secret), `secret ${secret} leaked into logs:\n${all}`);
  }
  assert.ok(captured.length > 0, "expected the SDK to emit at least one log event");
});
