import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import type { PrincipalKind } from "./roles.js";
import type { VerifiedEmailState } from "./index.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

test("tenants.users.list: kind and verified_email_state are typed; absent decode to undefined", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = isPlatformMint(url, init)
      ? { status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }
      : {
          items: [
            { id: "u1", kind: "human", verified_email_state: "unverified_required" },
            { id: "u2" },
          ],
          next_cursor: null,
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch: fetchImpl });
  const page = await realm.tenants.users.list("t1").page();
  const kind: PrincipalKind | undefined = page.items[0]!.kind;
  const state: VerifiedEmailState | undefined = page.items[0]!.verified_email_state;
  assert.equal(kind, "human");
  assert.equal(state, "unverified_required");
  assert.equal(page.items[1]!.kind, undefined);
  assert.equal(page.items[1]!.verified_email_state, undefined);
});
