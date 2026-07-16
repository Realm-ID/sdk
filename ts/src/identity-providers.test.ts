import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";

function mkFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return handler(url, init);
  }) as typeof fetch;
}

test("identityProviders.discover: GETs the realm discovery endpoint and decodes providers", async () => {
  let hitUrl = "";
  const fetch = mkFetch((url) => {
    hitUrl = url;
    return new Response(JSON.stringify({
      tenant_id: "tnt-1",
      providers: [
        { type: "google", client_type: "web", client_id: "goog-123" },
        { type: "firebase", client_type: "web", client_id: "fb-1", config: { apiKey: "k", authDomain: "d" } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  const res = await realm.identityProviders.discover({ platform: "web", tenantId: "tnt-1" });

  assert.match(hitUrl, /\/platforms\/r-1\/identity-providers/);
  assert.match(hitUrl, /platform=web/);
  assert.match(hitUrl, /tenant_id=tnt-1/);
  assert.equal(res.tenant_id, "tnt-1");
  assert.equal(res.providers.length, 2);
  assert.equal(res.providers[0]!.type, "google");
  assert.equal(res.providers[1]!.config?.apiKey, "k");
});

test("identityProviders.discover: sends Origin header when origin opt set", async () => {
  let sawOrigin: string | null = null;
  const fetch = mkFetch((_url, init) => {
    const h = new Headers(init?.headers);
    sawOrigin = h.get("origin");
    return new Response(JSON.stringify({ providers: [] }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ realmId: "r-1", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await realm.identityProviders.discover({ origin: "https://app.partner.com" });
  assert.equal(sawOrigin, "https://app.partner.com");
});
