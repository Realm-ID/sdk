/**
 * ADR-117 / R7 + R9 admin surface: realm config `contacts.unique_kinds` + `confirmLockout` +
 * `unique_kinds_report`, contact proof send/confirm on `me`, invitation resend, and the 17 new
 * error codes (registered in the bundled `@realm-id/sdk`; pinned here so a console never
 * sees them collapse into the status fallback).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ERROR_CODES, RealmError } from "@realm-id/sdk";
import type { RequestOptions } from "@realm-id/sdk/internal";

import { PlatformsClient } from "./platforms.js";
import { MeClient } from "./me.js";
import { createAdmin } from "./index.js";
import { realmFetchAsHttpClient, type HttpLike } from "./transport.js";
import type { RealmConfigPatch, RealmConfigResponse } from "./types.js";

function makeHttp(response: unknown): { http: HttpLike; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push(opts);
      return response as T;
    },
  };
  return { http, calls };
}

describe("realm config: contacts.unique_kinds (ADR-117 D1, D8)", () => {
  it("the patch type accepts a list and null; the view carries the resolved list", () => {
    const set: RealmConfigPatch = { contacts: { unique_kinds: ["phone"] } };
    const reset: RealmConfigPatch = { contacts: { unique_kinds: null } };
    assert.deepEqual(set.contacts?.unique_kinds, ["phone"]);
    assert.equal(reset.contacts?.unique_kinds, null);
  });

  it("updateConfig sends confirm_lockout as a QUERY parameter only when asked", async () => {
    const { http, calls } = makeHttp({ id: "p1", config: {} });
    const client = new PlatformsClient(http);
    await client.updateConfig("p1", { contacts: { unique_kinds: [] } });
    assert.equal(calls[0]!.query, undefined);
    await client.updateConfig("p1", { contacts: { unique_kinds: [] } }, { confirmLockout: true });
    assert.deepEqual(calls[1]!.query, { confirm_lockout: "true" });
    assert.equal(calls[1]!.method, "PATCH");
    assert.deepEqual(calls[1]!.body, { contacts: { unique_kinds: [] } });
    assert.equal(calls[1]!.headers, undefined, "never a header");
  });

  it("getConfigResponse returns the envelope with unique_kinds_report beside config", async () => {
    const wire: RealmConfigResponse = {
      id: "p1",
      config: {} as RealmConfigResponse["config"],
      unique_kinds_report: { phone: { values_on_multiple_memberships: 3 }, email: { values_on_multiple_memberships: 0 } },
    };
    const { http, calls } = makeHttp(wire);
    const out = await new PlatformsClient(http).getConfigResponse("p 1");
    assert.equal(calls[0]!.path, "/platforms/p%201/config");
    assert.equal(out.unique_kinds_report?.["phone"]?.values_on_multiple_memberships, 3);
  });
});

describe("me: contact proof (R7)", () => {
  it("sendContactProof POSTs delivery_mode and reads {delivered} from the 200", async () => {
    const { http, calls } = makeHttp({ delivered: "sms" });
    const out = await new MeClient(http).sendContactProof({ contactId: "c/1", deliveryMode: "sms" });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.path, "/me/contacts/c%2F1/proof");
    assert.deepEqual(calls[0]!.body, { delivery_mode: "sms" });
    assert.deepEqual(out, { delivered: "sms" });
  });

  it("confirmContactProof POSTs the code and returns the proven contact", async () => {
    const { http, calls } = makeHttp({ id: "c1", kind: "phone", value: "+1555", verified: true, verified_at: "2026-10-19T00:00:00Z" });
    const out = await new MeClient(http).confirmContactProof({ contactId: "c1", code: "123456" });
    assert.equal(calls[0]!.path, "/me/contacts/c1/proof/confirm");
    assert.deepEqual(calls[0]!.body, { code: "123456" });
    assert.deepEqual(out, { id: "c1", kind: "phone", value: "+1555", verified: true, verifiedAt: "2026-10-19T00:00:00Z" });
  });
});

describe("tenants.invitations.resend (R9)", () => {
  it("POSTs /tenants/{id}/invitations/{inviteId}/resend through createAdmin", async () => {
    const seen: Array<{ method: string; url: string }> = [];
    const realm = {
      async fetch(url: string | URL | Request, init: RequestInit = {}) {
        seen.push({ method: init.method ?? "GET", url: String(url) });
        return new Response(JSON.stringify({ id: "i1", status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const admin = createAdmin(realm as never, { baseUrl: "https://api.partner.com", realmId: "r1" } as never);
    await admin.tenants.invitations.resend("t 1", "i1");
    assert.equal(seen[0]!.method, "POST");
    assert.ok(seen[0]!.url.endsWith("/tenants/t%201/invitations/i1/resend"), seen[0]!.url);
  });
});

const NEW_CODES = [
  "unique_kinds_requires_password", "password_login_required", "unique_kind_lockout",
  "unique_kind_lockout_check_failed", "unique_kind_duplicates", "email_keyed_signin_enabled",
  "require_verified_email_conflict", "idp_requires_identifying_email", "idp_requires_identifying_phone",
  "domain_sso_requires_unique_email", "invite_contact_not_identifying", "recipient_email_not_identifying",
  "invalid_invitation_token", "contact_not_found", "contact_already_verified", "contact_changed",
  "reset_email_not_identifying",
] as const;

describe("ADR-117 error codes (17)", () => {
  it("are all in the registry", () => {
    assert.equal(NEW_CODES.length, 17);
    const missing = NEW_CODES.filter((c) => !(ERROR_CODES as readonly string[]).includes(c));
    assert.deepEqual(missing, []);
  });

  it("are claimed by the admin transport, not collapsed into the status fallback", async () => {
    let n = 0;
    for (const code of NEW_CODES) {
      const realm = {
        async fetch() {
          return new Response(JSON.stringify({ error: { code, message: "x" } }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        },
      };
      const http = realmFetchAsHttpClient(realm as never, { baseUrl: "https://api.partner.com" });
      await assert.rejects(
        () => http.request({ method: "GET", path: "/x" }),
        (e: unknown) => {
          assert.ok(e instanceof RealmError);
          assert.equal(e.code, code);
          return true;
        },
      );
      n += 1;
    }
    assert.equal(n, 17);
  });
});

describe("me.listContacts (GET /me/contacts)", () => {
  it("pages the {items,next_cursor,total} envelope and forwards cursor/limit", async () => {
    const row = (id: string) => ({ id, kind: "email", value: "a@b.c", verified: true, tenant_id: "t1" });
    const calls: RequestOptions[] = [];
    const http: HttpLike = {
      async request<T>(opts: RequestOptions): Promise<T> {
        calls.push(opts);
        return (opts.query?.["cursor"] === "c2"
          ? { items: [row("b")], next_cursor: null, total: 2 }
          : { items: [row("a")], next_cursor: "c2", total: 2 }) as T;
      },
    };
    const seen: string[] = [];
    for await (const c of new MeClient(http).listContacts({ limit: 1 })) seen.push(c.id);
    assert.deepEqual(seen, ["a", "b"]);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.path, "/me/contacts");
    assert.equal(calls[0]!.query?.["limit"], 1);
    assert.equal(calls[1]!.query?.["cursor"], "c2");
  });
});
