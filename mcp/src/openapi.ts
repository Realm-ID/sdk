// get_endpoint's source: the PUBLIC served spec, fetched at runtime and cached in the isolate.
// This is the only network call the worker makes, and it is an anonymous GET (ADR-062: docs layer only).

export const SPEC_URL = "https://auth.realmid.dev/.well-known/openapi.json";

type Json = Record<string, unknown>;
export type Spec = Json & { paths?: Record<string, Record<string, unknown>>; components?: Json; info?: Json };

export interface SpecLoaderOptions {
  url?: string;
  ttlMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** Returns a loader that caches the spec for ttlMs and serves a stale copy if a refresh fails. */
export function createSpecLoader(opts: SpecLoaderOptions = {}): () => Promise<Spec> {
  const url = opts.url ?? SPEC_URL;
  const ttl = opts.ttlMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchFn ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
  let cached: { spec: Spec; at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < ttl) return cached.spec;
    try {
      const res = await doFetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const spec = (await res.json()) as Spec;
      if (!spec || typeof spec !== "object" || !spec.paths) throw new Error("response is not an OpenAPI document");
      cached = { spec, at: now() };
      return spec;
    } catch (e) {
      if (cached) return cached.spec;
      throw new Error(
        `The public OpenAPI spec is unreachable (${url}): ${e instanceof Error ? e.message : String(e)}. ` +
          "Try again shortly, or read the spec at that URL directly.",
      );
    }
  };
}

const METHODS = ["get", "put", "post", "delete", "patch", "options", "head"];

function resolve(node: unknown, spec: Spec, seen: string[], depth: number): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(n, spec, seen, depth));
  if (!node || typeof node !== "object") return node;
  const obj = node as Json;
  if (typeof obj.$ref === "string") {
    const ref = obj.$ref;
    if (seen.includes(ref)) return { $ref: ref, note: "circular reference, not expanded" };
    if (depth > 6) return { $ref: ref, note: "not expanded (depth limit)" };
    const target = ref.replace(/^#\//, "").split("/").reduce<unknown>((o, k) => (o as Json | undefined)?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    if (target === undefined) return { $ref: ref, note: "unresolved reference" };
    return resolve(target, spec, [...seen, ref], depth + 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v, spec, seen, depth)]));
}

function templateMatches(template: string, concrete: string): boolean {
  const re = new RegExp(`^${template.split(/\{[^}]+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
  return re.test(concrete);
}

export interface Endpoint {
  method: string;
  path: string;
  summary?: string;
  operation: unknown;
}

export function findEndpoint(spec: Spec, method: string, path: string):
  | { ok: true; endpoint: Endpoint }
  | { ok: false; error: string } {
  const m = method.trim().toLowerCase();
  const paths = spec.paths ?? {};
  const p = path.trim();
  const key = paths[p] ? p : Object.keys(paths).find((t) => templateMatches(t, p.split("?")[0]));
  if (!key) {
    const near = Object.keys(paths).filter((t) => t.includes(p.split("/").filter(Boolean)[0] ?? "\0")).slice(0, 10);
    return { ok: false, error: `No path '${path}' in the served spec.${near.length ? ` Similar paths: ${near.join(", ")}.` : ""}` };
  }
  const item = paths[key];
  const op = item[m] as Json | undefined;
  if (!op || !METHODS.includes(m)) {
    const have = METHODS.filter((x) => item[x]).map((x) => x.toUpperCase());
    return { ok: false, error: `'${key}' has no ${method.toUpperCase()} operation. It has: ${have.join(", ")}.` };
  }
  const operation = resolve({ ...op, parameters: [...((item.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])] }, spec, [], 0);
  return {
    ok: true,
    endpoint: { method: m.toUpperCase(), path: key, summary: op.summary as string | undefined, operation },
  };
}
