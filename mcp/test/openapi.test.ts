import { describe, expect, it } from "vitest";
import { createSpecLoader, findEndpoint } from "../src/openapi";

const spec = {
  openapi: "3.0.3",
  info: { title: "RealmID", version: "9.9.9" },
  paths: {
    "/tenants/{id}": {
      get: { summary: "Get a tenant", parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Tenant" } } } } } },
      delete: { summary: "Delete a tenant" },
    },
    "/auth/login": { post: { summary: "Log in" } },
  },
  components: { schemas: { Tenant: { type: "object", properties: { id: { type: "string" }, parent: { $ref: "#/components/schemas/Tenant" } } } } },
};

const ok = () => new Response(JSON.stringify(spec));

describe("findEndpoint", () => {
  it("matches a template path exactly, case-insensitive on method", () => {
    const r = findEndpoint(spec, "get", "/tenants/{id}");
    expect(r.ok && r.endpoint.summary).toBe("Get a tenant");
  });
  it("matches a concrete path against a template", () => {
    const r = findEndpoint(spec, "DELETE", "/tenants/0190abc");
    expect(r.ok && r.endpoint.path).toBe("/tenants/{id}");
  });
  it("resolves $ref and survives a cycle", () => {
    const r = findEndpoint(spec, "GET", "/tenants/{id}");
    const s = r.ok && (r.endpoint.operation as any).responses["200"].content["application/json"].schema;
    expect(s.properties.id.type).toBe("string");
    expect(JSON.stringify(s)).toContain("circular");
  });
  it("lists the methods that do exist", () => {
    const r = findEndpoint(spec, "PUT", "/tenants/{id}");
    expect(!r.ok && r.error).toMatch(/GET, DELETE|DELETE, GET/);
  });
  it("says so for an unknown path", () => {
    const r = findEndpoint(spec, "GET", "/nope");
    expect(!r.ok && r.error).toContain("/nope");
  });
});

describe("createSpecLoader", () => {
  it("fetches once and caches within the ttl", async () => {
    let calls = 0;
    const load = createSpecLoader({ url: "https://x/openapi.json", ttlMs: 1000, now: () => 0, fetchFn: async () => { calls++; return ok(); } });
    await load();
    await load();
    expect(calls).toBe(1);
  });
  it("refetches after the ttl", async () => {
    let calls = 0;
    let t = 0;
    const load = createSpecLoader({ url: "https://x/o", ttlMs: 10, now: () => t, fetchFn: async () => { calls++; return ok(); } });
    await load();
    t = 11;
    await load();
    expect(calls).toBe(2);
  });
  it("gives a clear error when unreachable, and serves a stale copy if it has one", async () => {
    const down = createSpecLoader({ url: "https://x/o", ttlMs: 10, now: () => 0, fetchFn: async () => { throw new Error("boom"); } });
    await expect(down()).rejects.toThrow(/public OpenAPI spec is unreachable/i);
    let fail = false;
    let t = 0;
    const flaky = createSpecLoader({ url: "https://x/o", ttlMs: 10, now: () => t, fetchFn: async () => (fail ? new Response("no", { status: 503 }) : ok()) });
    await flaky();
    fail = true;
    t = 100;
    expect(((await flaky()) as any).info.version).toBe("9.9.9");
  });
  it("errors on a non-200 with no cache", async () => {
    const load = createSpecLoader({ url: "https://x/o", ttlMs: 10, now: () => 0, fetchFn: async () => new Response("no", { status: 502 }) });
    await expect(load()).rejects.toThrow(/502/);
  });
});
