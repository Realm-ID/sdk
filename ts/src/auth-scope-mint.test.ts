import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

// ---- ADR-097 mint half: TokenRequest.scope ----
//
// scope.ts is the ENFORCEMENT half — scopesFrom / scopeAllows / scopePolicy —
// and it shipped in all three SDKs. The MINT half shipped in none of them, so
// the operand those functions evaluate had no way onto the wire from the SDK
// at all. These tests hold it there.

interface Recorded { url: string; body: unknown }

/** Auto-services the platform-token bootstrap, records everything else. */
function recorder(handler: () => Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = init.body; } }
    if (url.endsWith("/auth/login") && (body as { grant_type?: string })?.grant_type === "platform_api_key") {
      return new Response(JSON.stringify({
        status: "ok", subject_type: "platform", refresh_token: "rtok-platform",
        access_token: "pt_test_abc", expires_in: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Only the mint is recorded. The platform-token bootstrap and the
    // GET /platforms/mine that follows it are harness traffic, and counting
    // them would make `calls.length === 0` assert something else entirely.
    if (url.endsWith("/auth/token")) calls.push({ url, body });
    return handler();
  }) as typeof fetch;
  return { fetch, calls };
}

const okMint = () => new Response(JSON.stringify({
  access_token: "at2", refresh_token: "rt2", expires_in: 900, subject_type: "user",
}), { status: 200, headers: { "content-type": "application/json" } });

const REALM_ID = "01HREALM";
const API_KEY = "rk_live_test123";
const mk = (fetch: typeof fetch) =>
  createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });

// The defect test: before this field existed the body had no `scope` key,
// whatever the caller asked for.
test("auth.token: scope goes on the wire space-delimited, in order", async () => {
  const { fetch, calls } = recorder(okMint);
  await mk(fetch).auth.token({
    refreshToken: "rt", tenantId: "t1", scope: ["orders:read", "orders:write"],
  });
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.scope, "orders:read orders:write");
});

// Keyed on emptiness, NOT on undefined — the inverse of rolePermissions, and
// for a stated reason: the issuer's parseScope trims and returns nil for "",
// so an empty scope IS an absent one and `"scope": ""` could not mean anything.
// rolePermissions differs because an empty list there is a real instruction
// ("this role confers nothing here"), answered with a 403.
for (const [name, scope] of [
  ["undefined", undefined],
  ["empty", [] as string[]],
] as const) {
  test(`auth.token: omits the scope key entirely for a ${name} scope`, async () => {
    const { fetch, calls } = recorder(okMint);
    await mk(fetch).auth.token({ refreshToken: "rt", tenantId: "t1", scope });
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal("scope" in body, false, `scope key present: ${JSON.stringify(body)}`);
  });
}

// The reason scope is string[] and not the wire's raw string.
//
// A SPACE inside one entry is not a parse error on the wire — it is a SILENT
// AUTHORITY CHANGE: "orders read" is read by the issuer as TWO scopes. Taking a
// list and refusing an unsendable entry turns that into an error at the call
// site. The charset is RFC 6749 §3.3 and fixed by spec, which is what makes
// checking it client-side safe from drift; the per-realm BOUNDS
// (max_permission_strings / max_permission_string_len) are deliberately left to
// the server, because those are realm configuration and a local copy would
// refuse what the server accepts.
for (const [name, entry] of [
  ["an embedded space, which splits it into two scopes", "orders read"],
  ["a tab, which the issuer also splits on", "orders\tread"],
  ['a double quote, outside the scope-token charset', 'orders"read'],
  ["a backslash, outside the scope-token charset", "orders\\read"],
  ["nothing at all", ""],
  ["DEL, which is not printable ASCII", "orders\x7f"],
] as const) {
  test(`auth.token: refuses a scope entry containing ${name}`, async () => {
    const { fetch, calls } = recorder(okMint);
    await assert.rejects(
      () => mk(fetch).auth.token({
        refreshToken: "rt", tenantId: "t1", scope: ["orders:read", entry],
      }),
      (e: unknown) => e instanceof RealmError && e.code === "bad_request",
    );
    // The mint must not happen at all — a refusal that still spent the refresh
    // token would rotate it and log the caller out.
    assert.equal(calls.length, 0, "the request must not reach the issuer");
  });
}
