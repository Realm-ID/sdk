/**
 * ADR-094 per-org SSO domain grants — the nine calls a partner console needs.
 * Partners MUST surface this flow themselves (an org cannot self-serve), which
 * is why it belongs in the SDK rather than in RealmID's own console.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SSODomainsClient } from "./sso-domains.js";
import type { HttpLike } from "./transport.js";
import { SSO_DOMAIN_METHODS, SSO_DOMAIN_PROOF_METHODS } from "@realm-id/sdk";

type Req = { method?: string; path: string; body?: unknown; query?: Record<string, unknown> };

function spy(reply: unknown = {}) {
  const reqs: Req[] = [];
  const http: HttpLike = {
    async request<T>(opts: Req): Promise<T> {
      reqs.push(opts);
      return reply as T;
    },
  };
  return { http, reqs };
}

const GRANT = {
  id: "g1", tenant_id: "t1", domain: "acme.com", method: "dns_txt", status: "claimed",
  verified: false, requested_at: "2026-08-30T00:00:00Z", created_at: "2026-08-30T00:00:00Z",
};

test("list → GET the org-scoped collection, items unwrapped", async () => {
  const { http, reqs } = spy({ items: [GRANT] });
  const out = await new SSODomainsClient(http, "p1").list("t1");
  assert.equal(reqs[0].method, "GET");
  assert.equal(reqs[0].path, "/platforms/p1/tenants/t1/sso-domains");
  assert.deepEqual(out, [GRANT]);
});

test("list tolerates a page with no items key", async () => {
  const { http } = spy({});
  assert.deepEqual(await new SSODomainsClient(http, "p1").list("t1"), []);
});

test("claim POSTs the domain, and omits `method` so the server default applies", async () => {
  const { http, reqs } = spy({ grant: GRANT });
  await new SSODomainsClient(http, "p1").claim("t1", "acme.com");
  assert.equal(reqs[0].method, "POST");
  assert.equal(reqs[0].path, "/platforms/p1/tenants/t1/sso-domains");
  assert.deepEqual(reqs[0].body, { domain: "acme.com" });
});

test("claim passes an explicit method through", async () => {
  const { http, reqs } = spy({ grant: GRANT });
  await new SSODomainsClient(http, "p1").claim("t1", "acme.com", "html_file");
  assert.deepEqual(reqs[0].body, { domain: "acme.com", method: "html_file" });
});

test("verify POSTs to the domain-scoped verify route with the domain encoded", async () => {
  const { http, reqs } = spy({ grant: GRANT, verified: false });
  const out = await new SSODomainsClient(http, "p1").verify("t1", "sub.acme.com");
  assert.equal(reqs[0].path, "/platforms/p1/tenants/t1/sso-domains/sub.acme.com/verify");
  assert.equal(out.verified, false, "a not-yet-published record is a 200, not an error");
});

test("request and revoke target the same domain-scoped path with the right verbs", async () => {
  const { http, reqs } = spy(GRANT);
  const c = new SSODomainsClient(http, "p1");
  await c.request("t1", "acme.com");
  await c.revoke("t1", "acme.com");
  assert.deepEqual(
    reqs.map((r) => [r.method, r.path]),
    [
      ["POST", "/platforms/p1/tenants/t1/sso-domains/acme.com/request"],
      ["DELETE", "/platforms/p1/tenants/t1/sso-domains/acme.com"],
    ],
  );
});

test("the platform owner's queue is a DIFFERENT path — no tenant segment", async () => {
  const { http, reqs } = spy({ items: [GRANT] });
  await new SSODomainsClient(http, "p1").listForPlatform();
  assert.equal(reqs[0].path, "/platforms/p1/sso-domains");
  assert.equal(reqs[0].query, undefined);
});

test("the queue's status filter rides as a query param, not string-concatenated", async () => {
  const { http, reqs } = spy({ items: [] });
  await new SSODomainsClient(http, "p1").listForPlatform({ status: "claimed,pending" });
  assert.equal(reqs[0].path, "/platforms/p1/sso-domains");
  assert.deepEqual(reqs[0].query, { status: "claimed,pending" });
});

test("approve/reject act on the GRANT id, not the domain", async () => {
  const { http, reqs } = spy(GRANT);
  const c = new SSODomainsClient(http, "p1");
  await c.approve("g1");
  await c.reject("g1", "not yours");
  assert.deepEqual(reqs.map((r) => r.path), [
    "/platforms/p1/sso-domains/g1/approve",
    "/platforms/p1/sso-domains/g1/reject",
  ]);
  assert.deepEqual(reqs[1].body, { reason: "not yours" });
});

test("reject with no reason sends no body", async () => {
  const { http, reqs } = spy(GRANT);
  await new SSODomainsClient(http, "p1").reject("g1");
  assert.equal(reqs[0].body, undefined);
});

test("every path segment the caller supplies is encoded", async () => {
  const { http, reqs } = spy({ items: [] });
  await new SSODomainsClient(http, "p/1").list("t/1");
  assert.equal(reqs[0].path, "/platforms/p%2F1/tenants/t%2F1/sso-domains");
});

test("the ADR-094 vocabularies come from @realm-id/sdk, not a local copy", () => {
  // If this package ever declares its own union, this is the test that says so.
  assert.ok(SSO_DOMAIN_METHODS.includes("platform_approval"));
  assert.equal(SSO_DOMAIN_PROOF_METHODS.includes("platform_approval"), false,
    "an owner's attestation is NOT proof and must never set `verified`");
  assert.equal(SSO_DOMAIN_PROOF_METHODS.length, 3);
});
