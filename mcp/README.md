# RealmID docs MCP server

A small, read-only [MCP](https://modelcontextprotocol.io) server that lets an AI coding agent look up
the RealmID partner docs instead of guessing. It is a docs layer only: it never calls the RealmID API
(the CLI is the tool for that, ADR-062). The one network call it makes is an anonymous GET of the public
spec at `https://auth.realmid.dev/.well-known/openapi.json`.

**Status: built, tested, not deployed.** `mcp.realmid.dev` does not exist yet. See "Not deployed yet".

## Tools

All five are read-only. Every result carries a public GitHub URL and the sdk commit the docs were built from.

| Tool | Input | Returns |
|---|---|---|
| `search_docs` | `query`, optional `limit` | Ranked sections: doc, heading, anchor, URL, snippet |
| `get_section` | `doc`, `anchor` | Full text of one section (anchors are GitHub heading slugs) |
| `get_endpoint` | `method`, `path` | One operation from the served OpenAPI spec (params, body, responses). A clear error if the spec is unreachable |
| `get_claim` | `id` | A hard rule by id (for example `user-id-byo-uuid`), from `docs/claims.yaml` (falls back to the FAQ's `Claim:` lines) |
| `explain_error` | `code` | The error reference row: when it fires and what to do |

There is also a resource, `realmid://about`, naming the sdk commit the index was built from. A plain
`GET /` on the worker prints the same.

## Connect from Claude Code

```bash
claude mcp add --transport http realmid https://mcp.realmid.dev/mcp
```

Other MCP clients: point them at `https://mcp.realmid.dev/mcp` (Streamable HTTP, no auth).

## How it works

- `scripts/build-index.mjs` reads `docs/migrating-to-realmid.md`, `docs/partner-integration-guide.md`,
  `docs/error-reference.md` and (when present) `docs/claims.yaml` from this repo, and writes
  `src/generated/index.json` (gitignored). The worker bundles that file; **there is no runtime doc
  fetch**. The docs it serves are exactly those of the commit it was built from.
- `src/index.ts` is the Worker. It uses the MCP TypeScript SDK's own stateless `createMcpHandler`
  (`@modelcontextprotocol/server` v2): no sessions, no Durable Objects, no auth, because the content is
  public. Cloudflare's docs recommend this stateless handler for new servers over the older `McpAgent`.
- Error codes are parsed from both table shapes in the error reference (`Code | When | What to do` and
  `Code | Meaning | What to do`), keeping `|` inside backticks in its cell. A code with no row (for example
  one the issuer sends that the reference has not documented yet) gets an explicit "no row" answer,
  never a guess.

## Develop and test

```bash
cd mcp
npm ci
npm test        # builds the index, typechecks, runs vitest (fixtures + real-docs positive controls)
```

`npm test` is part of the sdk gate: `make check` runs it (skipped loudly if `mcp/node_modules` is missing).
`npm run dev` runs `wrangler dev` locally and needs Node 22 or newer.

## Not deployed yet

- `.github/workflows/deploy-mcp.yml` deploys only on a manual `workflow_dispatch`. It needs a repository
  secret `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, and Routes/DNS edit on the `realmid.dev` zone).
  **That secret does not exist yet**, so the workflow fails at its deploy step until the owner adds it.
- `wrangler.toml` declares `mcp.realmid.dev` as a custom domain. Cloudflare creates the DNS record on the
  first deploy.
- The package is `"private": true` and is not published to npm.
