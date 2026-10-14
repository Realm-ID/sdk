// Cloudflare Worker entry for mcp.realmid.dev. Stateless Streamable HTTP via the MCP TypeScript SDK's
// own createMcpHandler: no Durable Objects, no sessions, no auth (these are public docs).
import { createMcpHandler } from "@modelcontextprotocol/server";
import generated from "./generated/index.json";
import { createSpecLoader } from "./openapi";
import { aboutText, createDocsServer } from "./server";
import type { DocsIndex } from "./types";

export interface WorkerOptions {
  index?: DocsIndex;
  fetchFn?: typeof fetch;
}

export function createWorker(opts: WorkerOptions = {}) {
  const index = opts.index ?? (generated as unknown as DocsIndex);
  const loadSpec = createSpecLoader({ fetchFn: opts.fetchFn });
  const mcp = createMcpHandler(() => createDocsServer({ index, loadSpec }));
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/mcp") return mcp.fetch(request);
      if (pathname === "/" && request.method === "GET") {
        return new Response(`${aboutText(index)}\n\nMCP endpoint: /mcp (Streamable HTTP)\n`, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("Not found. The MCP endpoint is /mcp.\n", { status: 404 });
    },
  };
}

const worker = createWorker();
export default { fetch: (request: Request) => worker.fetch(request) };
