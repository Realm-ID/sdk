/**
 * `useDeviceApproval(userCode)` (SPEC §15.9): the state machine under `<DeviceApproval/>`.
 *
 * Built on `realm.device.*` (SPEC §15.8). Step-up is collected IN the card: approve throws the classified
 * challenge, the hook enters `needs_mfa`, `mfa.submit(code)` calls `realm.device.completeStepUp` and
 * retries approve ONCE. A `session_limit_reached` is never step-up: it stays `ready` with `sessionLimit`.
 * `not_owner` and `not_found` are separate states for the host, but MUST render the same copy (Q2).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRevocationSessions, type DeviceRequestView, type StepUpChallenge } from "@realm-id/web";
import { useRealm } from "./index.js";

export type DeviceApprovalState =
  | "loading" | "ready" | "needs_mfa" | "approved" | "denied" | "expired" | "not_owner" | "not_found";

export interface DeviceApprovalError {
  code: string;
  message: string;
  /** Seconds, for `device_code_attempts_exceeded` (the Retry-After header). */
  retryAfter?: number;
}

export interface DeviceSessionRow {
  id: string;
  device?: string;
  device_name?: string;
  last_active?: string | number;
  last_seen_at?: string | number;
}

export interface DeviceApproveOptions {
  tenantId?: string;
  revokeExistingSessions?: boolean;
}

export interface DeviceMfa {
  kind: "verify" | "enroll";
  methods: string[];
  /** Absent for `enroll`: there is no code to collect. */
  submit?: (code: string) => Promise<void>;
  cancel: () => void;
}

export interface DeviceSessionLimit {
  sessions: DeviceSessionRow[];
  revokeAndRetry: (ids: string[]) => Promise<void>;
}

export interface DeviceApprovalApi {
  state: DeviceApprovalState;
  request: DeviceRequestView | null;
  approve: (opts?: DeviceApproveOptions) => Promise<void>;
  deny: () => Promise<void>;
  /** Resolves true when the sign-out went through. Only does anything once the request is collected. */
  signOut: () => Promise<boolean>;
  /** Re-run the inspect (the "Try again" of a failed inspect). */
  reload: () => void;
  /** Re-run the last approve with the same choices (the "Try again" of DQ2). */
  retryApprove: () => Promise<void>;
  mfa: DeviceMfa | null;
  sessionLimit: DeviceSessionLimit | null;
  error: DeviceApprovalError | null;
}

interface S {
  state: DeviceApprovalState;
  request: DeviceRequestView | null;
  error: DeviceApprovalError | null;
  mfa: DeviceMfa | null;
  sessionLimit: DeviceSessionLimit | null;
}

const EMPTY: S = { state: "loading", request: null, error: null, mfa: null, sessionLimit: null };

/** 8 characters of the issuer's alphabet after removing the dash (ADR-122 D4); the alphabet is the issuer's. */
export function isWellFormedUserCode(code: string): boolean {
  const c = code.replace(/[-\s]/g, "");
  return c.length === 8 && /^[A-Za-z0-9]+$/.test(c);
}

export function timer(fn: () => void, ms: number, repeat: boolean): () => void {
  const h = repeat ? setInterval(fn, ms) : setTimeout(fn, ms);
  // Never keep a node process (SSR, tests) alive for a UI timer.
  (h as { unref?: () => void }).unref?.();
  return () => (repeat ? clearInterval(h) : clearTimeout(h));
}

const POLL_MS = 5000;
const MAX_TIMEOUT = 2 ** 31 - 1;

function fromView(v: DeviceRequestView): S {
  switch (v.status) {
    case "approved":
    case "collected":
      return { ...EMPTY, state: "approved", request: v };
    case "denied":
    case "failed":
      return { ...EMPTY, state: "denied", request: v };
    case "expired":
      return { ...EMPTY, state: "expired", request: v };
    default:
      if (Date.parse(v.expiresAt) <= Date.now()) return { ...EMPTY, state: "expired", request: v };
      return { ...EMPTY, state: "ready", request: v };
  }
}

function describe(e: unknown): DeviceApprovalError {
  const x = e as { code?: string; message?: string; retryAfter?: number; details?: { retryAfter?: number } };
  const out: DeviceApprovalError = { code: x?.code ?? "unknown", message: x?.message ?? "" };
  const ra = x?.retryAfter ?? x?.details?.retryAfter;
  if (typeof ra === "number") out.retryAfter = ra;
  return out;
}

export function useDeviceApproval(userCode: string): DeviceApprovalApi {
  const { realm } = useRealm();
  const dev = realm.device;
  const [s, setS] = useState<S>(EMPTY);
  const sRef = useRef<S>(s);
  sRef.current = s;
  const seq = useRef(0);
  const lastOpts = useRef<DeviceApproveOptions>({});
  const runRef = useRef<(o: DeviceApproveOptions) => Promise<void>>(async () => {});

  const load = useCallback(() => {
    const my = ++seq.current;
    if (!isWellFormedUserCode(userCode)) {
      setS({ ...EMPTY, state: "ready", error: { code: "bad_request", message: "Check the code." } });
      return;
    }
    setS(EMPTY);
    // A macrotask hop: the first render is always `loading`, even against an instant fake.
    const cancel = timer(() => {
      dev.inspect(userCode).then(
        (v) => { if (my === seq.current) setS(fromView(v)); },
        (e) => { if (my === seq.current) setS((p) => failure(e, { ...p, request: null }, {}, "inspect")); },
      );
    }, 0, false);
    return cancel;
  }, [dev, userCode]);

  // `failure` closes over runRef so mfa.submit / revokeAndRetry can re-run approve.
  function failure(e: unknown, p: S, opts: DeviceApproveOptions, from: "inspect" | "approve" | "keep"): S {
    const x = e as { code?: string; details?: Record<string, unknown> };
    const code = x?.code ?? "";
    if (code === "device_approval_not_allowed") return { ...EMPTY, state: "not_owner" };
    if (code === "forbidden") return { ...EMPTY, state: "not_found" };
    if (from === "approve" && code === "device_authorization_not_pending") {
      return { ...EMPTY, state: "expired", request: p.request };
    }
    const keepState = from === "keep" ? p.state : "ready";
    const step = x?.details?.stepUp as StepUpChallenge | undefined;
    if (from === "approve" && step && (code === "mfa_required" || code === "mfa_registration_required")) {
      const verify = step.kind === "verify" && !!step.challengeToken;
      const mfa: DeviceMfa = {
        kind: verify ? "verify" : "enroll",
        methods: step.methods ?? ["totp"],
        cancel: () => setS((q) => ({ ...q, state: "ready", mfa: null, error: null })),
      };
      if (verify) {
        mfa.submit = async (otp: string) => {
          try {
            await dev.completeStepUp(step, otp);
          } catch {
            setS((q) => ({ ...q, error: { code: "mfa_failed", message: "That code didn't work. Try again." } }));
            return;
          }
          await runRef.current(opts);
        };
      }
      return { ...p, state: "needs_mfa", mfa, error: null, sessionLimit: null };
    }
    if (from === "approve" && code === "session_limit_reached") {
      const token = String(x?.details?.revocation_token ?? "");
      const rows = (Array.isArray(x?.details?.sessions) ? x!.details!.sessions : []) as DeviceSessionRow[];
      const sessionLimit: DeviceSessionLimit = {
        sessions: rows,
        revokeAndRetry: async (ids) => {
          try {
            const baseUrl = (realm as unknown as { _transport?: { baseUrl?: string } })._transport?.baseUrl ?? "";
            const rs = createRevocationSessions(realm, { baseUrl });
            for (const id of ids) await rs.revoke(id, token);
          } catch (err) {
            setS((q) => ({ ...q, error: describe(err) }));
            return;
          }
          await runRef.current(opts);
        },
      };
      return { ...p, state: "ready", mfa: null, error: describe(e), sessionLimit };
    }
    return { ...p, state: keepState, mfa: null, sessionLimit: null, error: describe(e) };
  }

  const run = useCallback(async (opts: DeviceApproveOptions) => {
    const my = ++seq.current;
    lastOpts.current = opts;
    setS((p) => ({ ...p, state: "loading", error: null, mfa: null, sessionLimit: null }));
    const body: { userCode: string; tenantId?: string; revokeExistingSessions?: boolean } = { userCode };
    if (opts.tenantId !== undefined) body.tenantId = opts.tenantId;
    if (opts.revokeExistingSessions !== undefined) body.revokeExistingSessions = opts.revokeExistingSessions;
    try {
      await dev.approve(body);
      if (my !== seq.current) return;
      setS((p) => ({
        ...p, state: "approved", error: null, mfa: null, sessionLimit: null,
        request: p.request ? { ...p.request, status: "approved" } : p.request,
      }));
    } catch (e) {
      if (my !== seq.current) return;
      setS((p) => failure(e, p, opts, "approve"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev, userCode]);
  runRef.current = run;

  useEffect(() => {
    const cancel = load();
    return () => { seq.current++; cancel?.(); };
  }, [load]);

  // Local countdown: a pending request that runs out becomes `expired` without a round trip.
  const expiresAt = s.request?.expiresAt;
  useEffect(() => {
    if (!expiresAt || (s.state !== "ready" && s.state !== "needs_mfa")) return;
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return;
    return timer(() => setS((p) => (p.state === "ready" || p.state === "needs_mfa" ? { ...p, state: "expired", mfa: null } : p)), Math.min(Math.max(ms, 0), MAX_TIMEOUT), false);
  }, [s.state, expiresAt]);

  // Approved and waiting: re-inspect every 5 s until collected, denied, failed or expired.
  const reqStatus = s.request?.status;
  useEffect(() => {
    if (s.state !== "approved" || reqStatus === "collected") return;
    return timer(() => {
      dev.inspect(userCode).then(
        (v) => setS((p) => (p.state === "approved" ? { ...fromView(v) } : p)),
        () => { /* a failed poll keeps the last answer; the next tick retries */ },
      );
    }, POLL_MS, true);
  }, [dev, userCode, s.state, reqStatus]);

  const approve = useCallback(async (opts: DeviceApproveOptions = {}) => {
    if (sRef.current.state !== "ready") return;
    await run(opts);
  }, [run]);

  const retryApprove = useCallback(async () => {
    if (sRef.current.state !== "ready") return;
    await run(lastOpts.current);
  }, [run]);

  const deny = useCallback(async () => {
    const cur = sRef.current;
    const cancellable = cur.state === "ready" || (cur.state === "approved" && cur.request?.status !== "collected");
    if (!cancellable) return;
    try {
      await dev.deny(userCode);
      setS((p) => ({ ...EMPTY, state: "denied", request: p.request ? { ...p.request, status: "denied" } : p.request }));
    } catch (e) {
      setS((p) => failure(e, p, {}, "keep"));
    }
  }, [dev, userCode]);

  const signOut = useCallback(async () => {
    if (sRef.current.request?.status !== "collected") return false;
    try {
      await dev.signOut(userCode);
      return true;
    } catch (e) {
      setS((p) => failure(e, p, {}, "keep"));
      return false;
    }
  }, [dev, userCode]);

  return {
    state: s.state, request: s.request, approve, deny, signOut, reload: load as () => void, retryApprove,
    mfa: s.mfa, sessionLimit: s.sessionLimit, error: s.error,
  };
}
