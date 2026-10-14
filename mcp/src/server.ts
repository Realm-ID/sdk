// MCP wiring: five read-only tools and one resource. Every tool is a thin call into tools.ts /
// openapi.ts; nothing here reaches the RealmID API (the OpenAPI GET is anonymous and public).
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type Spec, findEndpoint } from "./openapi";
import { explainError, getClaim, getSection, searchDocs } from "./tools";
import type { DocsIndex } from "./types";

export interface ServerDeps {
  index: DocsIndex;
  loadSpec: () => Promise<Spec>;
}

export function aboutText(index: DocsIndex): string {
  const s = index.source;
  return [
    "RealmID partner docs MCP server (read-only, docs only).",
    `Built from ${s.repo} commit ${s.commit}${s.dirty ? " (+ uncommitted docs changes)" : ""} at ${s.built_at}.`,
    `Docs: ${index.docs.map((d) => d.path).join(", ")}.`,
    `Claims come from ${s.claims_source}. Endpoints come from the public served OpenAPI spec at runtime.`,
    "It never calls the RealmID API. Use the CLI for anything that does.",
  ].join("\n");
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function text(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function createDocsServer({ index, loadSpec }: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "realmid-docs", version: "0.1.0" },
    {
      instructions:
        "Read-only access to the RealmID partner docs. Start with search_docs, then get_section for the full text. " +
        "Every result carries a public GitHub URL and the sdk commit the docs were built from.",
    },
  );

  server.registerTool(
    "search_docs",
    {
      description: "Search the RealmID partner docs (FAQ, integration guide, error reference). Returns ranked sections with anchor, URL and snippet.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Plain words, e.g. 'bring your own user id'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => text(searchDocs(index, query, limit ?? 5)),
  );

  server.registerTool(
    "get_section",
    {
      description: "Full text of one doc section. doc is a doc id (see search_docs results); anchor is its GitHub-style heading slug.",
      inputSchema: z.object({ doc: z.string().min(1), anchor: z.string().min(1) }),
      annotations: READ_ONLY,
    },
    async ({ doc, anchor }) => {
      const r = getSection(index, doc, anchor);
      return text(r, !r.ok);
    },
  );

  server.registerTool(
    "get_endpoint",
    {
      description: "One operation from the public served OpenAPI spec (auth.realmid.dev/.well-known/openapi.json): parameters, request body, responses. Path may be a template or a concrete path.",
      inputSchema: z.object({
        method: z.string().min(1).describe("HTTP method, e.g. POST"),
        path: z.string().min(1).describe("e.g. /tenants/{id}"),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ method, path }) => {
      let spec: Spec;
      try {
        spec = await loadSpec();
      } catch (e) {
        return text({ ok: false, source: index.source, error: e instanceof Error ? e.message : String(e) }, true);
      }
      const r = findEndpoint(spec, method, path);
      return text({ ...r, source: index.source, spec_version: (spec.info as { version?: string } | undefined)?.version }, !r.ok);
    },
  );

  server.registerTool(
    "get_claim",
    {
      description: "A hard rule from the docs by id (e.g. 'user-id-byo-uuid'): the statement, whether it is an absence claim, and the doc sections that state it.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const r = getClaim(index, id);
      return text(r, !r.ok);
    },
  );

  server.registerTool(
    "explain_error",
    {
      description: "What an SDK/issuer error code means and what to do about it, from the error reference.",
      inputSchema: z.object({ code: z.string().min(1).describe("e.g. tenant_required") }),
      annotations: READ_ONLY,
    },
    async ({ code }) => {
      const r = explainError(index, code);
      return text(r, !r.ok);
    },
  );

  server.registerResource(
    "about",
    "realmid://about",
    { title: "About this server", description: "Which sdk commit the docs were built from.", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: aboutText(index) }] }),
  );

  return server;
}
