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

The worker needs **Node 22** (`engines`, `.nvmrc`; wrangler 4.x). The laptop runs Node 20 and services run
in Docker, so use the repo-root Makefile, which runs everything inside `node:22` (`docker run --rm --init`,
no host port, `node_modules` in the named volume `realmid-mcp-node-modules`):

```bash
make mcp-test   # npm ci + npm test: builds the index, typechecks, runs vitest (fixtures + real-docs positive controls)
make mcp-dev    # wrangler dev inside the container, port 8787 (not published to the host)
docker exec realmid-mcp-dev curl -s localhost:8787/   # from a second terminal
```

`make check` also runs `npm test` here on the host (skipped loudly if `mcp/node_modules` is missing).
`mcp/scripts/verify-deployed.mjs <base-url> <sha>` is the post-deploy assertion the workflow runs
(GET `/` names the commit; a real `tools/list` returns all five tools); it is tested in
`test/verify-deployed.test.ts` with negative controls.

## Not deployed yet

The code, the workflow and the post-deploy proof are built. Exactly three steps remain, none of them code:

1. **GitHub Environment `production` on `Realm-ID/sdk`**, restricted to `main`. It does not exist yet; the owner
   (or devops) creates it.
2. **Token minted by infra-provisioning.** Once the owner approves, devops mints a Workers-scoped token
   (profile `workers-deploy-realmid`: Workers Scripts:Edit, plus Routes/DNS edit on the `realmid.dev` zone)
   through `mint-cloudflare-tokens` into that environment as secret `CLOUDFLARE_API_TOKEN` and variable
   `CLOUDFLARE_ACCOUNT_ID`. Neither exists today; until they do, the workflow's preflight step fails with
   an `::error::` naming this and publishes nothing.
3. **Dispatch** `.github/workflows/deploy-mcp.yml` (Actions, "Run workflow", branch `main`). It tests on Node 22,
   runs `npx wrangler@4.151.0 deploy`, then fails unless `https://mcp.realmid.dev/` names the deployed commit
   and `tools/list` returns all five tools. Cloudflare creates the DNS record and certificate on this first
   deploy (`wrangler.toml` declares the custom domain).

Never run `wrangler deploy` or `wrangler login` from a laptop. The package is `"private": true` and is not
published to npm.
