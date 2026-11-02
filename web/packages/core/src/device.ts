/**
 * Device approval, browser half (SPEC §15.8; BFF-SPEC § Device approval): `realm.device.*`.
 *
 * Four typed calls against the partner BFF's browser routes, plus `completeStepUp`. Step-up is handled
 * IN THE CARD, never by a host-wide prompt: every request carries the RequestInit marker
 * `realmidStepUp: "caller"`, which `withStepUpRetry` honours by returning the response untouched. The
 * step-up `412` therefore reaches `approve`, which throws a `RealmError` whose `details.stepUp` is the
 * classified challenge; the caller collects the code, calls `completeStepUp`, and retries ONCE.
 *
 * A `412 session_limit_reached` is NOT step-up: it is thrown with `details.revocation_token` and
 * `details.sessions` for `createRevocationSessions`.
 *
 * Not exported from the package index except through `realm.device` and the types.
 */

import { RealmError, classifyHttpStatus, type ErrorCode } from "./errors.js";
import { parseErrorEnvelope, unwrapData } from "./envelope.js";
import { STEP_UP_MARKER, parseStepUp, type StepUpChallenge } from "./stepup.js";

/** A device authorization as `/device/inspect` returns it (camelCase, BFF-SPEC). */
export interface DeviceRequestView {
  id: string;
  status: "pending" | "approved" | "collected" | "denied" | "expired" | "failed";
  clientId?: string;
  deviceName?: string;
  deviceNameSource?: string;
  reportedIp?: string;
  reportedIpSource?: string;
  createdAt: string;
  expiresAt: string;
  subjectType: "user" | "service";
  subjectLabel: string;
  /** True when the BFF always replaces the subject's other sessions (sdk/go ReplaceExistingSessions). */
  replaceExistingSessions: boolean;
  /** True when approving needs fresh MFA. */
  stepUp?: boolean;
  /** Why a `failed` request failed (a failure at collection). */
  failureReason?: string;
  collectedSessionId?: string;
}

export interface DeviceApproveRequest {
  userCode: string;
  tenantId?: string;
  revokeExistingSessions?: boolean;
}

export interface DeviceApproveResult {
  id: string;
  status: "approved";
  subjectType: "user" | "service";
  expiresAt: string;
}

export interface DeviceSignOutResult {
  subjectType: "user" | "service";
  scope: "account" | "session";
}

export interface DeviceClient {
  inspect(userCode: string): Promise<DeviceRequestView>;
  approve(req: DeviceApproveRequest): Promise<DeviceApproveResult>;
  /** Verify the step-up challenge and adopt the session it mints; the caller then retries approve once. */
  completeStepUp(challenge: StepUpChallenge, code: string): Promise<void>;
  deny(userCode: string): Promise<{ id: string; status: "denied" }>;
  signOut(userCode: string): Promise<DeviceSignOutResult>;
}

export interface DeviceDeps {
  paths: { inspect: string; approve: string; deny: string; signOut: string };
  resolve: (path: string) => string;
  /** The realm's authenticated fetch (anonymous when there is no session yet). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Verify + adopt; throws on failure. */
  verify: (challenge: StepUpChallenge, code: string) => Promise<void>;
}

export function createDeviceClient(deps: DeviceDeps): DeviceClient {
  async function call<T>(path: string, body: unknown): Promise<T> {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
      [STEP_UP_MARKER]: "caller",
    } as RequestInit;
    let res: Response;
    try {
      res = await deps.fetch(deps.resolve(path), init);
    } catch (e) {
      // A typed error raised before the request left (a dead session) is an auth state, not transport.
      if (typeof (e as { code?: unknown } | null)?.code === "string") throw e;
      throw new RealmError("network_error", (e as Error)?.message ?? "fetch failed");
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return unwrapData<T>(text ? JSON.parse(text) : undefined);
    }
    return fail(res);
  }

  return {
    inspect: (userCode) => call<DeviceRequestView>(deps.paths.inspect, { userCode }),
    approve: (req) => call<DeviceApproveResult>(deps.paths.approve, req),
    deny: (userCode) => call<{ id: string; status: "denied" }>(deps.paths.deny, { userCode }),
    signOut: (userCode) => call<DeviceSignOutResult>(deps.paths.signOut, { userCode }),
    async completeStepUp(challenge, code) {
      try {
        await deps.verify(challenge, code);
      } catch (e) {
        if (e instanceof RealmError) throw e;
        throw new RealmError("mfa_failed", "That code didn't work.", 0, undefined);
      }
    },
  };
}

/** Throw the RealmError for a non-2xx response, keeping the server's code and gate payloads. */
async function fail(res: Response): Promise<never> {
  // Classify the step-up BEFORE the body is consumed (parseStepUp reads a clone).
  const challenge = await parseStepUp(res);
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  const env = parseErrorEnvelope(parsed, res.status);
  let details: Record<string, unknown> | undefined = env.details ? { ...env.details } : undefined;
  // SPEC §15.9 `error.retryAfter` has no named wire source: it is the Retry-After header (seconds).
  const ra = Number(res.headers.get("Retry-After"));
  if (res.headers.get("Retry-After") !== null && Number.isFinite(ra) && ra >= 0) {
    details = { ...(details ?? {}), retryAfter: ra };
  }
  if (challenge) details = { ...(details ?? {}), stepUp: challenge };
  const code = (env.code ?? classifyHttpStatus(res.status, parsed)) as ErrorCode;
  throw new RealmError(code, env.message, res.status, { code, message: env.message, details, raw: parsed }, details);
}
