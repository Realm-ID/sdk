import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PlatformTokenManager } from "./platform-token-manager.js";
import { staticApiKey, GRANT_TOKEN_EXCHANGE } from "./credential.js";
import type { Credential, CredentialSource } from "./credential.js";
import { NOOP_LOGGER } from "./logger.js";

// SPEC §4.0.1 `platform_id` on the token exchange.

const REALM = "11111111-2222-3333-4444-555555555555";

async function exchangeBody(credential: CredentialSource): Promise<Record<string, string>> {
  let body: Record<string, string> = {};
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, string>;
    return new Response(
      JSON.stringify({ status: "ok", subject_type: "platform", access_token: "at", expires_in: 300 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const mgr = new PlatformTokenManager({
    credential, baseUrl: "https://auth.test", fetch: fetchImpl, logger: NOOP_LOGGER, realmId: REALM,
  });
  await mgr.getToken();
  return body;
}

const workload = (extra: Partial<Credential> = {}): CredentialSource => ({
  fetch: async () => ({ grantType: GRANT_TOKEN_EXCHANGE, subjectToken: "wl.jwt", ...extra }),
});

test("token exchange sends the handle's realm id as platform_id", async () => {
  assert.equal((await exchangeBody(workload()))["platform_id"], REALM);
});

test("a credential's platformId wins over the handle's realm id", async () => {
  assert.equal((await exchangeBody(workload({ platformId: "plat-override" })))["platform_id"], "plat-override");
});

test("the platform_api_key grant never sends platform_id", async () => {
  const body = await exchangeBody(staticApiKey("rk_live_x"));
  assert.equal("platform_id" in body, false);
});
