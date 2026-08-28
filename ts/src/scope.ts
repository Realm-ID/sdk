/**
 * ADR-097 — SDK-enforced route authorization.
 *
 * A partner adding an endpoint to their own product must not have to update
 * configuration inside RealmID. RealmID stores identity and attestation; the
 * PARTNER'S REPO owns the route -> scope and role -> scope maps; this module is
 * the gate that evaluates one against the other.
 *
 * The `scope` claim (RFC 9068 §2.2.3, defined by reference to RFC 8693 §4.2, in
 * RFC 6749 §3.3 format) is a space-delimited STRING of the partner's OWN scope
 * strings. RealmID never parses, validates or stores them — but it DOES
 * intersect them with any user-API-key `permissions_cap` at mint, so the token
 * carries ONE effective set. Nothing here has to intersect anything.
 *
 * ## Three layers, on purpose
 *
 * 1. `scopeAllows` / `scopeAllowsAny` — a pure predicate over one claim. No I/O.
 * 2. `ScopePolicy`                    — route -> required scopes, default DENY.
 * 3. `createScopeMiddleware`, `fastifyScopeHook` — thin shells over layer 2.
 *
 * Layer 3 is a handful of lines BECAUSE layer 1 is a predicate over a single
 * claim with no I/O. That is the payoff of RealmID doing the intersection: had
 * the issuer emitted both operands, every adapter would carry policy.
 *
 * ## Token scope vs `capAllows` — which to use
 *
 * Both are correct; they trade different things, and mixing them without
 * deciding gets the worst of both.
 *
 * | | token scope | `capAllows` |
 * |---|---|---|
 * | per-request I/O | none | one live read |
 * | revocation lag | the realm's `access_ttl_seconds` (1..86400) | zero |
 *
 * Use token scope by DEFAULT. Use `capAllows` for operations where a stale
 * grant is unacceptable — money movement, permission administration, data
 * export. `capAllows` is not deprecated and is not going away.
 *
 * @module
 */

import type { Claims } from "./claims.js";
import { globMatch } from "./middleware.js";
import { RealmError } from "./errors.js";

/**
 * Returns the scopes a verified token carries, in the order the issuer wrote
 * them.
 *
 * Returns `[]` for a token with no `scope` claim — which every caller here
 * treats as "no granted authority", the fail-closed reading. That is also the
 * correct reading of a token minted before ADR-097, and of one whose caller
 * simply asked for nothing.
 *
 * A non-string `scope` (an array, say) yields `[]`. The claim is a STRING by
 * RFC 9068 §2.2.3, and quietly accepting an array here would mask a wire
 * mismatch that ought to be loud.
 */
export function scopesFrom(claims: Claims | null | undefined): string[] {
  const raw = (claims as { scope?: unknown } | null | undefined)?.scope;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Reports whether the token carries EVERY required scope (all-of).
 *
 * All-of is the default because it is the safe reading of silence: a partner
 * writing `["orders:read", "orders:write"]` and getting any-of would be granted
 * on half the evidence they asked for, and nothing would tell them.
 * {@link scopeAllowsAny} exists for the cases where any-of is meant, and has to
 * be named.
 *
 * Fails CLOSED. Returns `false` when claims are absent, the `scope` claim is
 * absent or malformed, or ANY required scope is missing.
 *
 * Calling it with NO required scopes returns `false`, not `true`. "Requires
 * nothing" is almost always a route someone forgot to configure, and
 * vacuous-true on an empty policy is how a gate silently stops gating. A
 * genuinely public route is declared as such — see {@link ScopeRule.public}.
 *
 * Comparison is EXACT and CASE-SENSITIVE. No wildcards, no prefixes, no
 * hierarchy — the same rule `capAllows` states, for the same reason: RealmID
 * does not interpret a partner's vocabulary, and neither does this. `read` does
 * not imply `read:orders`, and `Read` is not `read`.
 */
export function scopeAllows(claims: Claims | null | undefined, ...required: string[]): boolean {
  if (required.length === 0) return false;
  const held = new Set(scopesFrom(claims));
  if (held.size === 0) return false;
  return required.every((r) => held.has(r));
}

/**
 * Reports whether the token carries AT LEAST ONE of the required scopes. Same
 * exact, case-sensitive matching and the same fail-closed rules as
 * {@link scopeAllows}, including the empty-required case.
 */
export function scopeAllowsAny(claims: Claims | null | undefined, ...required: string[]): boolean {
  if (required.length === 0) return false;
  const held = new Set(scopesFrom(claims));
  if (held.size === 0) return false;
  return required.some((r) => held.has(r));
}

// ---- Layer 2: the route map ----

/** One entry in a {@link ScopePolicy}. */
export interface ScopeRule {
  /**
   * Glob pattern, using the same matcher as `mfaProtectedPaths` (`*` within a
   * segment, `**` across segments) so a partner learns one path syntax for this
   * SDK rather than two.
   */
  path: string;
  /**
   * Restrict to one HTTP method. Omitted means ANY method — right for a
   * resource whose whole surface needs one scope, wrong for one where reading
   * and writing differ, so it is worth being deliberate about.
   */
  method?: string;
  /** What this route requires. ALL of them by default; see {@link anyOf}. */
  scopes?: string[];
  /**
   * Switch this rule to "at least one of `scopes`". Off by default, because
   * all-of is the safe reading of a list (see {@link scopeAllows}).
   */
  anyOf?: boolean;
  /**
   * Mark a route as needing NO scope at all.
   *
   * This exists so that "unauthenticated" is something a partner SAYS, never
   * something they get by forgetting. A policy denies by default, so an
   * unlisted route is refused rather than waved through — silence must never
   * mean open. `public` together with a non-empty `scopes` is a configuration
   * error and is reported by {@link validateScopePolicy}.
   */
  public?: boolean;
}

/**
 * A partner's route -> scope map: layer 2 of ADR-097's SDK surface, and the
 * thing that lives in THEIR repo rather than in RealmID.
 *
 * It DENIES BY DEFAULT. A request matching no rule is refused. That is the
 * whole point: adding an endpoint and forgetting to declare its scope must
 * produce a locked door, not an open one.
 *
 * Rules are evaluated IN ORDER and the FIRST match wins, so place a specific
 * rule before the general one it narrows. Order-dependence is stated rather
 * than sorted-for: "most specific wins" needs a specificity metric, and any
 * metric here would be a guess about a partner's routing.
 */
export type ScopePolicy = ScopeRule[];

/** The outcome of evaluating a policy against one request. */
export interface ScopeDecision {
  /** The answer. Everything else explains it. */
  allowed: boolean;
  /**
   * Whether ANY rule matched. `false` means the request was denied by the
   * default-deny rule — a configuration gap rather than an authorization
   * failure, and worth logging differently.
   */
  matched: boolean;
  /** The matched rule declared the route public. */
  public: boolean;
  /** What the matched rule asked for. */
  required: string[];
  /** Mirrors the matched rule. */
  anyOf: boolean;
  /**
   * Required scopes the token did not carry. Empty on an `anyOf` denial, where
   * no single scope is "the" missing one.
   */
  missing: string[];
}

const DENIED: ScopeDecision = {
  allowed: false,
  matched: false,
  public: false,
  required: [],
  anyOf: false,
  missing: [],
};

/**
 * Evaluates a policy for one request. Default DENY.
 *
 * A `null`/`undefined` policy denies everything. An SDK that treated "no
 * policy" as "allow everything" would make a wiring mistake indistinguishable
 * from a deliberately open service.
 */
export function decideScope(
  policy: ScopePolicy | null | undefined,
  claims: Claims | null | undefined,
  method: string,
  path: string,
): ScopeDecision {
  if (!policy) return { ...DENIED };
  const m = (method ?? "").toUpperCase();
  for (const rule of policy) {
    if (!rule.path) continue;
    if (rule.method && rule.method.toUpperCase() !== m) continue;
    if (!globMatch(rule.path, path)) continue;

    const required = rule.scopes ?? [];
    const anyOf = rule.anyOf ?? false;
    if (rule.public) {
      return { allowed: true, matched: true, public: true, required, anyOf, missing: [] };
    }
    if (anyOf) {
      return {
        allowed: scopeAllowsAny(claims, ...required),
        matched: true,
        public: false,
        required,
        anyOf,
        missing: [],
      };
    }
    const allowed = scopeAllows(claims, ...required);
    const held = new Set(scopesFrom(claims));
    return {
      allowed,
      matched: true,
      public: false,
      required,
      anyOf,
      missing: allowed ? [] : required.filter((s) => !held.has(s)),
    };
  }
  return { ...DENIED };
}

/** One problem found by {@link validateScopePolicy}. */
export interface ScopeConfigError {
  index: number;
  path: string;
  message: string;
}

/**
 * Reports configuration errors a partner should learn about at startup rather
 * than by watching requests fail.
 *
 * Returns EVERY problem, not the first: a partner fixing a route map wants the
 * whole list, and a validator that stops at the first error turns one deploy
 * into five.
 */
export function validateScopePolicy(policy: ScopePolicy): ScopeConfigError[] {
  const errs: ScopeConfigError[] = [];
  policy.forEach((rule, index) => {
    const path = rule.path ?? "";
    const scopes = rule.scopes ?? [];
    if (!path) {
      errs.push({ index, path, message: "rule has an empty path" });
    } else if (rule.public && scopes.length > 0) {
      errs.push({
        index,
        path,
        message: "rule is public but also lists scopes; a public route requires none",
      });
    } else if (!rule.public && scopes.length === 0) {
      // A rule requiring nothing and not marked public would deny every request
      // (scopeAllows refuses an empty requirement) — a working gate for the
      // wrong reason, and impossible to debug.
      errs.push({
        index,
        path,
        message: "rule lists no scopes and is not public; mark it public or give it a scope",
      });
    }
    for (const s of scopes) {
      if (!isRfc6749ScopeToken(s)) {
        errs.push({
          index,
          path,
          message:
            `scope "${s}" is not an RFC 6749 §3.3 scope-token; RealmID would refuse to mint it, ` +
            "so this rule could never be satisfied",
        });
      }
    }
  });
  return errs;
}

/**
 * RFC 6749 §3.3: `1*( %x21 / %x23-5B / %x5D-7E )` — printable ASCII minus
 * SPACE, `"` and `\`.
 *
 * Exposed through {@link validateScopePolicy} so a partner learns at STARTUP
 * that RealmID would refuse to mint a scope they have written into their route
 * map — which would otherwise present as a route no token can ever satisfy.
 */
export function isRfc6749ScopeToken(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x21) continue;
    if (c >= 0x23 && c <= 0x5b) continue;
    if (c >= 0x5d && c <= 0x7e) continue;
    return false;
  }
  return true;
}

// ---- Layer 3: framework adapters ----
//
// This SDK takes ZERO runtime dependencies, deliberately. The adapters below
// are typed STRUCTURALLY — they describe the shape of an Express or Fastify
// object rather than importing one — so using either costs a partner nothing
// and neither framework enters anybody's dependency tree.

/** The subset of an Express-style request these adapters read. */
export interface ScopeReqLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  realmid?: Claims;
}

/** The subset of an Express-style response these adapters write. */
export interface ScopeResLike {
  statusCode: number;
  setHeader?(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

/** Options shared by the layer-3 adapters. */
export interface ScopeMiddlewareOptions {
  /**
   * Called with the full decision before the 403 is written.
   *
   * This is where the missing scope names go. A denial with `matched === false`
   * is a ROUTE THE PARTNER NEVER DECLARED, not an unauthorized caller, and is
   * worth alerting on differently — the first is a deploy bug, the second is
   * ordinary traffic.
   */
  onScopeDenied?(req: ScopeReqLike, decision: ScopeDecision): void;
}

const FORBIDDEN_BODY = JSON.stringify({
  error: {
    code: "insufficient_scope",
    message: "this token does not carry the scope required for this route",
  },
});

function pathOf(req: ScopeReqLike): string {
  const raw = req.path ?? req.originalUrl ?? req.url ?? "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Express / Connect adapter.
 *
 * Mount it INSIDE `createMiddleware`, which is what verifies the token and puts
 * the claims on `req.realmid`. Mounted outside, there are no claims and —
 * correctly, and unhelpfully — every request is denied.
 *
 * Responds 403 with RFC 6750 §3.1's `insufficient_scope`. It deliberately does
 * NOT list the missing scopes: telling an unauthorized caller the names of the
 * permissions they lack is a map of the API's authority model, handed out for
 * free. The names reach the SERVER through `onScopeDenied`.
 */
export function createScopeMiddleware(
  policy: ScopePolicy,
  opts: ScopeMiddlewareOptions = {},
): (req: ScopeReqLike, res: ScopeResLike, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    const decision = decideScope(policy, req.realmid, req.method ?? "GET", pathOf(req));
    if (decision.allowed) {
      next();
      return;
    }
    opts.onScopeDenied?.(req, decision);
    res.statusCode = 403;
    res.setHeader?.("Content-Type", "application/json");
    res.end(FORBIDDEN_BODY);
  };
}

/**
 * Fastify `onRequest` hook adapter. Same policy, same 403, same
 * no-scope-names-on-the-wire rule as {@link createScopeMiddleware}.
 *
 * Fastify's reply object is typed structurally here for the same
 * zero-dependency reason as the Express one.
 */
export function fastifyScopeHook(
  policy: ScopePolicy,
  opts: ScopeMiddlewareOptions = {},
): (
  req: ScopeReqLike,
  reply: { code(status: number): { send(body: unknown): unknown } },
  done: (err?: unknown) => void,
) => void {
  return (req, reply, done) => {
    const decision = decideScope(policy, req.realmid, req.method ?? "GET", pathOf(req));
    if (decision.allowed) {
      done();
      return;
    }
    opts.onScopeDenied?.(req, decision);
    reply.code(403).send(JSON.parse(FORBIDDEN_BODY));
  };
}

// ---- ADR-097 mint half: turning a scope list into the wire value ----
//
// Everything above READS a `scope` claim. This WRITES one. It is the operand
// the enforcement layer evaluates, and until ts 0.42.0 / go 0.49.0 /
// java 0.39.0 no SDK could put it on the wire at all — so `scopePolicy` was
// reachable only by a partner who bypassed the SDK and hand-rolled
// POST /auth/token.

/**
 * Join a scope list into the wire's space-delimited string (RFC 6749 §3.3),
 * refusing any entry that would not survive the round trip.
 *
 * Returns `""` for an empty or absent list, which the caller omits from the
 * body entirely: the issuer's `parseScope` trims and returns nil for `""`, so
 * an empty scope and an absent one are the same request.
 *
 * Throws `RealmError { code: "bad_request" }` for an unsendable entry. Joining
 * it anyway would not fail — it would SUCCEED and mint a different set of
 * scopes than the caller asked for, which is the whole reason this SDK takes a
 * list rather than the raw wire string.
 *
 * The per-realm bounds (`max_permission_strings`, `max_permission_string_len`)
 * are NOT checked here: those are realm configuration and a client-side copy
 * would drift into refusing what the server accepts. The charset is fixed by
 * RFC and cannot.
 */
export function scopeWireValue(scopes: string[] | undefined | null): string {
  if (!scopes || scopes.length === 0) return "";
  for (const s of scopes) {
    if (!isRfc6749ScopeToken(s)) {
      throw new RealmError({
        code: "bad_request",
        message:
          `scope entry is not an RFC 6749 §3.3 scope-token: ${JSON.stringify(s)} — ` +
          "entries are joined with a space, so one containing a space, a quote, " +
          "a backslash or a non-printable byte would silently become a different " +
          "set of scopes than you asked for",
      });
    }
  }
  return scopes.join(" ");
}
