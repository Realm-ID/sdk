// The post-deploy assertion script, exercised against the real Worker in process. Includes the
// negative controls: a wrong sha and a missing tool must FAIL, otherwise the gate proves nothing.
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { verify } from "../scripts/verify-deployed.mjs";
import { fixture } from "./fixtures/index";

const worker = createWorker({ index: fixture, fetchFn: async () => new Response("{}") });
const viaWorker = ((req: string | URL | Request, init?: RequestInit) =>
  worker.fetch(req instanceof Request ? req : new Request(String(req), init))) as unknown as typeof fetch;
const sha = fixture.source.commit;

describe("verify-deployed", () => {
  it("passes against a worker serving the expected commit", async () => {
    const r = await verify("https://mcp.test", sha, viaWorker);
    expect(r.problems).toEqual([]);
    expect(r.tools).toHaveLength(5);
  });
  it("fails when the body names a different commit", async () => {
    const r = await verify("https://mcp.test", "0".repeat(40), viaWorker);
    expect(r.problems.join("\n")).toContain("does not name commit");
  });
  it("fails when a tool is missing", async () => {
    const fewer = async (req: RequestInfo | URL, init?: RequestInit) => {
      const res = await viaWorker(req, init);
      const text = await res.text();
      return new Response(text.replace("explain_error", "renamed"), { status: res.status });
    };
    const r = await verify("https://mcp.test", sha, fewer as unknown as typeof fetch);
    expect(r.problems.join("\n")).toContain("missing tools [explain_error]");
  });
});
