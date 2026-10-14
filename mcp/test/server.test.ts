// End to end through the MCP protocol (Streamable HTTP), in process: the Worker's own fetch handler.
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { fixture } from "./fixtures/index";

const spec = { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: { "/auth/login": { post: { summary: "Log in" } } } };
const worker = createWorker({
  index: fixture,
  fetchFn: async () => new Response(JSON.stringify(spec)),
});

async function rpc(method: string, params: unknown, id = 1) {
  const res = await worker.fetch(
    new Request("https://mcp.realmid.dev/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await res.text();
  const data = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()!
    : text;
  return { status: res.status, body: JSON.parse(data) };
}

const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } };

describe("worker over Streamable HTTP", () => {
  it("lists exactly the five read-only tools", async () => {
    const r = await rpc("tools/list", {});
    expect(r.body.result.tools.map((t: any) => t.name).sort()).toEqual(["explain_error", "get_claim", "get_endpoint", "get_section", "search_docs"]);
    for (const t of r.body.result.tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
  it("calls search_docs", async () => {
    const r = await rpc("tools/call", { name: "search_docs", arguments: { query: "bring your own user id" } });
    expect(r.body.result.content[0].text).toContain("can-i-bring-my-own-user-ids");
    expect(r.body.result.content[0].text).toContain("abc1234def");
  });
  it("calls get_endpoint via the injected fetch", async () => {
    const r = await rpc("tools/call", { name: "get_endpoint", arguments: { method: "POST", path: "/auth/login" } });
    expect(r.body.result.content[0].text).toContain("Log in");
  });
  it("marks a miss as isError", async () => {
    const r = await rpc("tools/call", { name: "explain_error", arguments: { code: "nope" } });
    expect(r.body.result.isError).toBe(true);
  });
  it("initialize works and the about resource names the commit", async () => {
    expect((await rpc("initialize", init)).body.result.serverInfo.name).toBeTruthy();
    const r = await rpc("resources/read", { uri: "realmid://about" });
    expect(r.body.result.contents[0].text).toContain("abc1234def");
  });
  it("serves a plain GET / with the commit, and 404s elsewhere", async () => {
    const ok = await worker.fetch(new Request("https://mcp.realmid.dev/"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("abc1234def");
    expect((await worker.fetch(new Request("https://mcp.realmid.dev/other"))).status).toBe(404);
  });
});
