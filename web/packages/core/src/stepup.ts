/**
 * Mid-session operation step-up MFA (ADR-096 D8) — the CLIENT half.
 *
 * A partner BFF gates a small set of irreversible / credential-affecting
 * operations and answers `412` with a step-up envelope. Every authenticated
 * call an app makes funnels through one `fetch`, so ONE wrapper at that seam
 * covers all of them:
 *
 *     const realm = createRealm({
 *       baseUrl,
 *       fetch: withStepUpRetry((i, init) => globalThis.fetch(i, init), {
 *         baseUrl: () => baseUrl,
 *         currentBearer: () => realm.peekAccessToken(),
 *         adopt: (v) => realm.adopt({ accessToken: v.session_token!, … }),
 *         prompt: async (challenge) => showCodeDialog(challenge),
 *       }),
 *     });
 *
 * Without the retry the gate is a dead end: the user proves MFA and the
 * operation they were trying to perform is simply lost. With it, the flow is
 * prompt → verify → replay.
 *
 * FOUR behaviours, each silent when it breaks:
 *
 *  1. **Classify the 412.** `mfa_required` is a VERIFY challenge (the caller
 *     has a confirmed factor and can answer with a code); `mfa_registration_
 *     required` is an ENROLL challenge (ADR-096 D4 — there is nothing to verify
 *     against, so a code prompt is unanswerable and the app must route to
 *     enrollment instead). **Anything else on a 412 falls through untouched**,
 *     most importantly the session-limit 412, which shares the status and
 *     carries a `revocation_token` its own flow needs.
 *  2. **ADOPT the freshly minted session bearer.** `/auth/mfa/verify` always
 *     issues a NEW `session_token` and deletes the one presented. The replay
 *     must carry the new one — the old bearer is already stamped on the `init`
 *     we were handed, so the replay REWRITES Authorization rather than reusing
 *     it. Reusing it gets `session_expired`, and the user watches a successful
 *     MFA verify log them out.
 *  3. **Preserve the acting tenant.** MFA proof is per (session, tenant)
 *     (ADR-059), so the verify call carries the CURRENT session bearer and the
 *     server writes the proof on the tenant the user was acting in. Landing on
 *     a different one fails the same gate again — an endless prompt. The verify
 *     route is public (the challenge token is the auth), so this header is
 *     context, not credentials.
 *  4. **Replay EXACTLY once.** The replay calls the raw `inner` fetch, never
 *     this wrapper, so a gate the user cannot satisfy costs one prompt, not a
 *     loop.
 *
 * The prompt is a CALLBACK on `deps` rather than module state, so two realms in
 * one page cannot share (or steal) each other's dialog.
 */

import { unwrapData } from "./envelope.js";

export interface StepUpChallenge {
  /**
   * `verify` — the caller has a confirmed enrollment and answers with a TOTP
   * code. `enroll` — the caller has no factor yet, so there is nothing to
   * verify against and a code prompt would be unanswerable (ADR-096 D4). The
   * two arrive as different error codes and MUST be routed differently.
   */
  kind: "verify" | "enroll";
  /** One-shot token that authorises the `/auth/mfa/verify` call. */
  challengeToken: string;
  /** Methods the server will accept. Defaults to `["totp"]` when unstated. */
  methods: string[];
  /** SPEC §10.4: `no_mfa` | `stale_mfa` | `fresh_required`. */
  reason: string;
  /** How recent the proof must be, in seconds. `0` when unstated. */
  maxAgeSeconds: number;
}

/**
 * Collects the answer. Resolves to the code, or `null` to abandon the step-up
 * (cancelled, or an ENROLL challenge this surface routes elsewhere) — in which
 * case the original 412 propagates to the caller unchanged, so nothing is
 * silently swallowed.
 */
export type StepUpPrompt = (challenge: StepUpChallenge) => Promise<string | null>;

/** The `/auth/mfa/verify` success body — the same shape a login returns. */
export interface StepUpVerifyResponse {
  session_token?: string;
  expires_at?: number;
  user?: { id: string; email?: string; display_name?: string };
  tenants?: Array<{ id: string; role?: string; display_name?: string }>;
  [k: string]: unknown;
}

export type StepUpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StepUpDeps {
  /** Absolute base URL of the BFF, read lazily so a rebuild is picked up. */
  baseUrl: () => string;
  /** The session bearer currently in force, or `undefined` before login. */
  currentBearer: () => string | undefined;
  /** Install the session the verify just minted. Called before the replay. */
  adopt: (verified: StepUpVerifyResponse) => void;
  /** Ask the user. Omit (or return `null`) to leave the 412 to the caller. */
  prompt?: StepUpPrompt;
  /** Override the verify path. Default `/auth/mfa/verify`. */
  verifyPath?: string;
}

/**
 * The two step-up codes and the challenge kind each implies. Anything NOT in
 * this map is not a step-up, whatever its status — that is behaviour 1, and it
 * is what keeps the session-limit 412 out of this flow.
 */
const STEP_UP_CODES: Readonly<Record<string, StepUpChallenge["kind"]>> = {
  mfa_required: "verify",
  mfa_registration_required: "enroll",
};

/**
 * Read the challenge off a 412 WITHOUT consuming the response — the caller
 * still gets the original body if we decide not to handle it. Returns `null`
 * for any 412 that is not a step-up.
 */
async function parseStepUp(res: Response): Promise<StepUpChallenge | null> {
  if (res.status !== 412) return null;
  let body: Record<string, unknown>;
  try {
    body = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const err = (body.error ?? {}) as { code?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const kind = STEP_UP_CODES[code];
  if (!kind) return null;
  return {
    kind,
    challengeToken: typeof body.mfa_challenge_token === "string" ? body.mfa_challenge_token : "",
    methods: Array.isArray(body.methods) ? (body.methods as string[]) : ["totp"],
    reason: typeof body.reason === "string" ? body.reason : "",
    maxAgeSeconds: typeof body.max_age_seconds === "number" ? body.max_age_seconds : 0,
  };
}

/**
 * Rewrite Authorization on the replay so it carries the token the verify just
 * minted (behaviour 2). Everything else about the request is preserved.
 */
function reauthorize(init: RequestInit | undefined, bearer: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${bearer}`);
  return { ...(init ?? {}), headers };
}

/** Wrap a fetch so operation step-up gates are answered and the call replayed. */
export function withStepUpRetry(inner: StepUpFetch, deps: StepUpDeps): StepUpFetch {
  return async (input, init) => {
    const res = await inner(input, init);
    const challenge = await parseStepUp(res);
    if (!challenge || !deps.prompt) return res;

    // An ENROLL challenge has no code to collect. The prompt is still asked (so
    // the app can explain and route to enrollment) but is expected to resolve
    // null, and the original 412 then reaches the caller.
    const code = await deps.prompt(challenge);
    if (!code) return res;

    const bearer = deps.currentBearer();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Behaviour 3. Absence degrades to "server picks a default tenant", which
    // is the bug this prevents — but an EMPTY header would be worse than none.
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    let verified: StepUpVerifyResponse;
    try {
      const vr = await inner(`${deps.baseUrl()}${deps.verifyPath ?? "/auth/mfa/verify"}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mfa_challenge_token: challenge.challengeToken, code }),
      });
      if (!vr.ok) return res;
      verified = unwrapData<StepUpVerifyResponse>(await vr.json());
    } catch {
      // A failed verify must surface the ORIGINAL 412, not a transport error
      // about a call the caller never made.
      return res;
    }
    if (!verified?.session_token) return res;

    deps.adopt(verified);

    // Behaviour 4: exactly one replay, through the RAW fetch — never back
    // through this wrapper, so a gate that keeps refusing cannot become a loop.
    return inner(input, reauthorize(init, verified.session_token));
  };
}
