import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import type { ContactVerification } from "./index.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

test("tenants.contactVerifications.list: masked contact fields are typed; absent decode to undefined", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const base = { contact_id: "c", user_id: "u", method: "google", provider_uid: "p", state: "pending", created_at: 1 };
    const body = isPlatformMint(url, init)
      ? { status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }
      : {
          items: [
            {
              id: "cv1", ...base,
              contact_kind: "phone", contact_value_masked: "+44*******123",
              user_display_name: "Jo", user_email_masked: "j***@example.com",
              asserted_identity: { email_masked: "k***@example.com", phone_masked: "+44*******123", display_name: "Kay" },
            },
            { id: "cv2", ...base },
          ],
          next_cursor: null,
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch: fetchImpl });
  const page = await realm.tenants.contactVerifications.list("t1").page();
  const row: ContactVerification = page.items[0]!;
  const masked: string | undefined = row.contact_value_masked;
  const kind: "email" | "phone" | "username" | undefined = row.contact_kind;
  assert.equal(masked, "+44*******123");
  assert.equal(kind, "phone");
  assert.equal(row.user_display_name, "Jo");
  assert.equal(row.user_email_masked, "j***@example.com");
  assert.equal(row.asserted_identity?.email_masked, "k***@example.com");
  assert.equal(row.asserted_identity?.phone_masked, "+44*******123");
  assert.equal(row.asserted_identity?.display_name, "Kay");
  assert.equal(page.items[1]!.contact_value_masked, undefined);
  assert.equal(page.items[1]!.asserted_identity, undefined);
});
