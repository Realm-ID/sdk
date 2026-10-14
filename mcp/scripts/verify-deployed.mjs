// Post-deploy proof for mcp.realmid.dev, run by .github/workflows/deploy-mcp.yml.
// Asserts by CONTENT, never by a status code alone: a CDN or a stale worker can answer 200.
//   1. GET /      -> the body names the commit that was just deployed (the build sha).
//   2. POST /mcp  -> a real MCP tools/list call returns all five tools.
// Usage: node scripts/verify-deployed.mjs <base-url> <expected-commit-sha>
import { pathToFileURL } from "node:url";

export const EXPECTED_TOOLS = ["search_docs", "get_section", "get_endpoint", "get_claim", "explain_error"];

/** A Streamable HTTP reply is either plain JSON or an SSE stream; take the last data: line. */
export function parseRpcBody(text) {
  const data = text.includes("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()
    : text;
  return JSON.parse(data);
}

export async function verify(base, sha, fetchFn = fetch) {
  const root = base.replace(/\/$/, "");
  const problems = [];

  const home = await fetchFn(`${root}/`);
  const homeBody = await home.text();
  if (home.status !== 200) problems.push(`GET / answered ${home.status}, expected 200`);
  if (!homeBody.includes(sha)) problems.push(`GET / body does not name commit ${sha} (stale or wrong deploy). Body: ${homeBody.slice(0, 300)}`);

  const res = await fetchFn(`${root}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  let names = [];
  try {
    names = (parseRpcBody(text).result?.tools ?? []).map((t) => t.name);
  } catch {
    problems.push(`POST /mcp tools/list did not return JSON-RPC (status ${res.status}): ${text.slice(0, 300)}`);
  }
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (res.status !== 200 || missing.length > 0) {
    problems.push(`tools/list: status ${res.status}, missing tools [${missing.join(", ")}], got [${names.join(", ")}]`);
  }
  return { problems, tools: names };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, sha] = process.argv.slice(2);
  if (!base || !sha) {
    console.error("usage: verify-deployed.mjs <base-url> <expected-commit-sha>");
    process.exit(2);
  }
  const { problems, tools } = await verify(base, sha);
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`OK: ${base} serves commit ${sha} and lists ${tools.length} tools (${tools.join(", ")})`);
}
