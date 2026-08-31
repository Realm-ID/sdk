import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { IntegrationsClient } from "@realm-id/sdk/internal";
import type { RequestOptions } from "@realm-id/sdk/internal";

/**
 * web-admin reuses the ts `IntegrationsClient` verbatim (SPEC §6.14), so these
 * tests only assert the wiring: the client routes to the right paths against a
 * mock http. The full behavioural coverage lives in the ts package's
 * integrations.test.ts.
 */

interface Captured {
  opts: RequestOptions;
}

function makeHttp(response: unknown): { http: unknown; calls: Captured[] } {
  const calls: Captured[] = [];
  const http = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push({ opts });
      return response as T;
    },
  };
  return { http, calls };
}

describe("admin.integrations wiring (ADR-082/083)", () => {
  // This asserted `role_id` until 2026-08-31 and PASSED the whole time the
  // call was answering 400 in production — because web-admin resolves
  // IntegrationsClient against its VENDORED @realm-id/sdk, so the stale copy
  // kept the stale assertion true. Fixing sdk/ts alone does not fix this
  // package; it needs the re-vendor. That is why the test now asserts the
  // absence of role_id and not merely the presence of permissions.
  it("install POSTs the tenant installations path with the stated permissions", async () => {
    const { http, calls } = makeHttp({ id: "inst-1", status: "installed" });
    const client = new IntegrationsClient(http as never, "r1");
    await client.install("t1", { integrationId: "intg-1", permissions: ["users:read"] });
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/integration-installations");
    assert.deepEqual(calls[0]!.opts.body, { integration_id: "intg-1", permissions: ["users:read"] });
    assert.equal("role_id" in (calls[0]!.opts.body as object), false);
  });

  it("listInstallations GETs the inbound-access path", async () => {
    const { http, calls } = makeHttp({ items: [], next_cursor: null });
    const client = new IntegrationsClient(http as never, "r1");
    await client.listInstallations("t1");
    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/tenants/t1/integration-installations");
  });

  it("mintToken POSTs the grant with skipPlatformToken (raw key is the credential)", async () => {
    const { http, calls } = makeHttp({ access_token: "jwt", expires_in: 600, tenant_id: "t", role: "svc" });
    const client = new IntegrationsClient(http as never, "r1");
    await client.mintToken({ apiKey: "rk_live_x", installationId: "inst-1", sourceOrgId: "org-a" });
    assert.equal(calls[0]!.opts.path, "/auth/login");
    assert.equal(calls[0]!.opts.skipPlatformToken, true);
    assert.deepEqual(calls[0]!.opts.body, {
      grant_type: "integration_installation",
      api_key: "rk_live_x",
      installation_id: "inst-1",
      source_org_id: "org-a",
    });
  });
});
