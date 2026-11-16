/**
 * custom-claims.ts — the server-side `customClaims(tenant, user)` handler and the
 * reserved-claim fold check (owner rulings 3 and 8, 2026-11-14; audit e-01, e-02).
 *
 * Spec: SPEC.md `SPEC10_2_custom_claims` (the handler), `SPEC4_2_claim_fold`
 * (key and payload checks), vectors in `testdata/claim-fold-vectors/`.
 *
 * Custom claims come from THIS handler only, which a partner wires on the
 * realm and which never sees request data.
 */

/** The issuer's `reservedClaims` from v0.151.0, plus `acr` (owner ruling 8). */
export const RESERVED_CLAIMS: readonly string[] = [
  "iss", "sub", "aud", "iat", "nbf", "exp", "jti", "azp", "tenant_id", "role",
  "mfa_at", "amr", "token_class", "scope", "product_roles", "sid", "events", "acr",
];

/**
 * Resolves the partner's custom claims for a principal in one org. SPEC §10.2:
 * no handler = no claims; empty = no claims; an error is retried 3 times then
 * REFUSES the mint; it runs on EVERY SDK-run mint; it MUST be side-effect free;
 * its inputs are never request data.
 */
export type CustomClaimsHandler = (
  tenantId: string,
  userId: string,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Your handler failed on every attempt, so the SDK refused to mint. Not a RealmError: it is your bug, not the issuer's. */
export class CustomClaimsError extends Error {
  readonly tenantId: string;
  readonly userId: string;
  readonly attempts: number;
  readonly cause?: unknown;
  constructor(tenantId: string, userId: string, attempts: number, cause?: unknown) {
    super(`customClaims handler failed after ${attempts} attempts for tenant ${tenantId}: ${String(cause)}`);
    this.name = "CustomClaimsError";
    this.tenantId = tenantId;
    this.userId = userId;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/** Your handler returned a key that is not printable ASCII or that folds to a reserved name (SPEC4_2_claim_fold rule 1). */
export class CustomClaimKeyError extends Error {
  readonly key: string;
  readonly reason: "refuse_reserved" | "refuse_charset";
  constructor(key: string, reason: "refuse_reserved" | "refuse_charset") {
    super(`customClaims handler returned key ${JSON.stringify(key)}: ${reason === "refuse_charset" ? "not printable ASCII" : "folds to a reserved claim name"}`);
    this.name = "CustomClaimKeyError";
    this.key = key;
    this.reason = reason;
  }
}

export const CUSTOM_CLAIMS_ATTEMPTS = 3;
export const CUSTOM_CLAIMS_BACKOFF_MS = [50, 150];

/** ASCII-only fold: `A`-`Z` to `a`-`z`, nothing else. */
export function foldAscii(k: string): string {
  return k.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const RESERVED_FOLDED = new Set(RESERVED_CLAIMS.map(foldAscii));

function printableAscii(k: string): boolean {
  return k.length > 0 && /^[\x20-\x7e]+$/.test(k);
}

/** SPEC4_2_claim_fold rule 1. Charset is checked FIRST. */
export function checkClaimKey(k: string): "accept" | "refuse_reserved" | "refuse_charset" {
  if (!printableAscii(k)) return "refuse_charset";
  if (RESERVED_FOLDED.has(foldAscii(k))) return "refuse_reserved";
  return "accept";
}

/**
 * Reads the TOP-LEVEL keys of a JSON object's raw text, unescaped, duplicates
 * preserved (a decoded map cannot hold a duplicate). Returns undefined when the
 * text is not an object it can walk; the caller's own JSON.parse already decided
 * validity.
 */
export function topLevelKeys(json: string): string[] | undefined {
  let i = 0;
  const n = json.length;
  const ws = () => { while (i < n && " \t\n\r".includes(json[i]!)) i++; };
  const str = (): string | undefined => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = json[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === '"') { i++; try { return JSON.parse(json.slice(start, i)) as string; } catch { return undefined; } }
      i++;
    }
    return undefined;
  };
  const skipValue = (): boolean => {
    ws();
    if (json[i] === '"') return str() !== undefined;
    if (json[i] === "{" || json[i] === "[") {
      let depth = 0;
      while (i < n) {
        const c = json[i]!;
        if (c === '"') { if (str() === undefined) return false; continue; }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") { depth--; if (depth === 0) { i++; return true; } }
        i++;
      }
      return false;
    }
    while (i < n && !",}".includes(json[i]!)) i++; // number / true / false / null
    return true;
  };
  ws();
  if (json[i] !== "{") return undefined;
  i++;
  const keys: string[] = [];
  ws();
  if (json[i] === "}") return keys;
  for (;;) {
    ws();
    if (json[i] !== '"') return undefined;
    const k = str();
    if (k === undefined) return undefined;
    keys.push(k);
    ws();
    if (json[i] !== ":") return undefined;
    i++;
    if (!skipValue()) return undefined;
    ws();
    if (json[i] === ",") { i++; continue; }
    if (json[i] === "}") return keys;
    return undefined;
  }
}

/**
 * SPEC4_2_claim_fold rule 2: a token's TOP-LEVEL keys, after unescaping, must be
 * printable ASCII, pairwise distinct under fold, and any key that is not
 * byte-equal to a reserved name must not fold to one. Returns the reason, or
 * undefined when the payload is clean. Refuses (never accepts) text it cannot walk.
 */
export function checkPayloadKeys(payloadJson: string): string | undefined {
  const keys = topLevelKeys(payloadJson);
  if (!keys) return "payload keys unreadable";
  const seen = new Set<string>();
  for (const k of keys) {
    if (!printableAscii(k)) return `claim key ${JSON.stringify(k)} is not printable ASCII`;
    const f = foldAscii(k);
    if (seen.has(f)) return `claim key ${JSON.stringify(k)} duplicates another key under fold`;
    seen.add(f);
    if (RESERVED_FOLDED.has(f) && !RESERVED_CLAIMS.includes(k)) return `claim key ${JSON.stringify(k)} folds to a reserved name`;
  }
  return undefined;
}

/**
 * Runs the handler under the §10.2 retry policy and checks its output. Returns
 * undefined (no claims) for no handler or an empty result.
 */
export async function resolveCustomClaims(
  handler: CustomClaimsHandler | undefined,
  tenantId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (!handler) return undefined;
  let last: unknown;
  let out: Record<string, unknown> | undefined;
  let ok = false;
  for (let attempt = 0; attempt < CUSTOM_CLAIMS_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      if (signal?.aborted) throw new CustomClaimsError(tenantId, userId, attempt, last);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CUSTOM_CLAIMS_BACKOFF_MS[attempt - 1]!);
        signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    try {
      out = await handler(tenantId, userId, signal);
      ok = true;
      break;
    } catch (err) {
      last = err;
      if (signal?.aborted) break;
    }
  }
  if (!ok) throw new CustomClaimsError(tenantId, userId, CUSTOM_CLAIMS_ATTEMPTS, last);
  if (!out || Object.keys(out).length === 0) return undefined;
  for (const k of Object.keys(out)) {
    const v = checkClaimKey(k);
    if (v !== "accept") throw new CustomClaimKeyError(k, v);
  }
  return out;
}
