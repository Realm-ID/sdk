/**
 * The ready-made target-side integration token handler (SPEC §14.8; R47, R50, R67.2, R94). A source
 * platform's caller POSTs `{"pass": "ip_..."}`; the handler rate-limits, then calls the TARGET realm's
 * token endpoint with `grant_type=integration_installation`, the target's platform token in
 * `Authorization` and the pass in `X-User-Token` (never in a body). On a split target it finishes the
 * half-signed answer and returns a normal token; otherwise it relays the issuer's answer verbatim. It
 * does no authorization of its own. There is no registration canary in v1. Mirrors
 * `sdk/go/integration_handler.go`.
 */

import type { Realm } from "./realm.js";
import { internalsOf } from "./realm-internals.js";
import { RealmError } from "./errors.js";

export interface IntegrationHandlerOptions {
  /** <= 0 or absent means the SDK default (30 per minute per client). */
  ratePerMinute?: number;
  /** Names the rate-limit bucket of a request. Absent = ONE global bucket (a `Request` has no address). */
  clientKey?: (req: Request) => string;
}

const DEFAULT_RATE = 30;
const BODY_MAX = 8 << 10;
const WINDOW_MS = 60_000;

const errorResponse = (status: number, code: string, message: string, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

/** At most BODY_MAX bytes of the request body as text; undefined when it is larger. */
async function readLimited(req: Request): Promise<string | undefined> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > BODY_MAX) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

/** The ready-made target-side handler: mount it on the target platform's BFF. */
export function createIntegrationTokenHandler(
  target: Realm, opts?: IntegrationHandlerOptions,
): (req: Request) => Promise<Response> {
  const ih = internalsOf(target);
  if (!ih) throw new RealmError({ code: "invalid_config", message: "realmid: the handler needs a realm made by createRealm" });
  const limit = opts?.ratePerMinute && opts.ratePerMinute > 0 ? opts.ratePerMinute : DEFAULT_RATE;
  const hits = new Map<string, { start: number; n: number }>();
  const allow = (key: string): boolean => {
    const now = ih.now();
    for (const [k, w] of hits) if (now - w.start >= WINDOW_MS) hits.delete(k); // bound memory
    let w = hits.get(key);
    if (!w) hits.set(key, (w = { start: now, n: 0 }));
    w.n++;
    return w.n <= limit;
  };
  const http = ih.http.withUserToken(""); // the pass is the ONLY actor, set per call below

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "POST only", { allow: "POST" });
    }
    if (!allow(opts?.clientKey ? opts.clientKey(req) : "")) {
      return errorResponse(429, "rate_limited", "too many requests", { "retry-after": "60" });
    }
    let pass = "";
    try {
      const text = await readLimited(req);
      const body = text === undefined ? undefined : (JSON.parse(text) as { pass?: unknown });
      if (body && typeof body.pass === "string") pass = body.pass;
    } catch {
      // falls through to the 400 below
    }
    if (pass === "") return errorResponse(400, "bad_request", 'body must be {"pass": "<install pass>"}');

    let resp: Response;
    try {
      resp = await http.requestRaw({
        method: "POST",
        path: ih.split ? "/auth/token/partial" : "/auth/token",
        headers: { "x-user-token": pass }, // R67.2: the pass rides in the header, never a body field
        body: { realm_id: ih.realmId, grant_type: "integration_installation" },
      });
    } catch {
      return errorResponse(502, "upstream_unavailable", "the token endpoint could not be reached");
    }
    let raw: string;
    try {
      raw = await resp.text();
    } catch {
      return errorResponse(502, "upstream_unavailable", "the token endpoint answer could not be read");
    }
    if (!ih.split || !resp.ok) {
      const headers: Record<string, string> = { "cache-control": "no-store" };
      const ct = resp.headers.get("content-type");
      if (ct) headers["content-type"] = ct;
      const ra = resp.headers.get("retry-after");
      if (ra) headers["retry-after"] = ra;
      return new Response(raw, { status: resp.status, headers });
    }
    try {
      const answer = await ih.split.finish(JSON.parse(raw));
      answer["token_type"] = "Bearer";
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch {
      return errorResponse(502, "cosign_failed", "the half-signed token could not be completed");
    }
  };
}
