/**
 * `<DeviceApproval/>` (SPEC §15.10, docs/device-approval-component.md): the rendered device-approval page.
 * Built ONLY on `useDeviceApproval`. Plain semantic markup, one stable `realmid-device*` class per part (a
 * public contract), a `classNames` prop per part (appended, never replacing), no CSS framework. The copy is
 * the doc's § 4 verbatim.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRealm } from "./index.js";
import { timer, useDeviceApproval, type DeviceApprovalApi } from "./useDeviceApproval.js";

export type DeviceApprovalOutcome = "approved" | "denied" | "signed_out";

export interface DeviceApprovalClassNames {
  root?: string;
  title?: string;
  codeForm?: string;
  codeInput?: string;
  details?: string;
  detailRow?: string;
  notice?: string;
  choice?: string;
  sessionList?: string;
  mfaForm?: string;
  actions?: string;
  primaryButton?: string;
  secondaryButton?: string;
  error?: string;
  countdown?: string;
}

export interface DeviceApprovalProps {
  /** The code from `?code=`; empty or absent shows the code-entry screen. */
  initialCode?: string;
  /** Used in "reported by <partnerName>". */
  partnerName: string;
  /** REQUIRED: where a person with no MFA factor sets one up (doc 4.7), so that state is never a dead end. */
  enrollHref: string;
  /** client_id -> label; an unknown id shows as typed. */
  appLabels?: Record<string, string>;
  classNames?: DeviceApprovalClassNames;
  onDone?: (outcome: DeviceApprovalOutcome) => void;
}

const REASONS: Record<string, (account: string) => string> = {
  subject_suspended: (a) => `${a} was suspended before the device connected`,
  user_suspended: () => "your account is suspended in this workspace",
  tenant_disabled: () => "this workspace is disabled",
  session_limit_reached: () => "the session limit was reached",
};

const cx = (...c: Array<string | undefined>) => c.filter(Boolean).join(" ");

function relative(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  return `${mins} minute${mins === 1 ? "" : "s"} ago`;
}

function Countdown({ expiresAt, className }: { expiresAt: string; className: string }) {
  const [, tick] = useState(0);
  useEffect(() => timer(() => tick((n) => n + 1), 1000, true), []);
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return <time className={className} dateTime={expiresAt}>{`${mm}:${ss} left`}</time>;
}

export function DeviceApproval(props: DeviceApprovalProps) {
  const { partnerName, enrollHref, appLabels, onDone } = props;
  const k = props.classNames ?? {};
  const { state: auth } = useRealm();

  const [code, setCode] = useState(props.initialCode ?? "");
  const [activeCode, setActiveCode] = useState(props.initialCode ?? "");
  const [revoke, setRevoke] = useState<boolean | null>(null);
  const [tenantPick, setTenantPick] = useState<string | null>(null);
  const [needChoice, setNeedChoice] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [mfaCode, setMfaCode] = useState("");
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  const h: DeviceApprovalApi = useDeviceApproval(activeCode);
  const { state, request, error } = h;

  // onDone fires only for the person's own action, never for a request that was already approved on load.
  const pending = useRef<DeviceApprovalOutcome | null>(null);
  useEffect(() => {
    if (pending.current === "approved" && state === "approved") { pending.current = null; onDone?.("approved"); }
    if (pending.current === "denied" && state === "denied") { pending.current = null; onDone?.("denied"); }
  }, [state, onDone]);

  const account = request ? (request.subjectType === "user" ? "your account" : request.subjectLabel) : "";
  const app = request?.clientId ? (appLabels?.[request.clientId] ?? request.clientId) : "An app";
  const root = (children: ReactNode, busy = false) => (
    <section
      className={cx("realmid-device", k.root)}
      aria-live="polite"
      aria-busy={busy ? "true" : undefined}
      data-state={state}
    >
      {children}
    </section>
  );
  const title = (t: string) => <h1 className={cx("realmid-device__title", k.title)}>{t}</h1>;
  const note = (t: string) => <p className={cx("realmid-device__notice", k.notice)}>{t}</p>;
  const errLine = (t: string) => <p className={cx("realmid-device__error", k.error)} role="alert">{t}</p>;
  const primary = (label: string, type: "submit" | "button" = "submit", onClick?: () => void) => (
    <button type={type} onClick={onClick} className={cx("realmid-device__button realmid-device__button--primary", k.primaryButton)}>{label}</button>
  );
  const secondary = (label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} className={cx("realmid-device__button realmid-device__button--secondary", k.secondaryButton)}>{label}</button>
  );
  const actions = (...c: ReactNode[]) => <div className={cx("realmid-device__actions", k.actions)}>{c}</div>;

  const denyAction = () => { pending.current = "denied"; void h.deny(); };

  // ---- one copy for not_found and not_owner (Q2) ----
  if (state === "not_found" || state === "not_owner") {
    return root(note("We couldn't find a request you can approve with this code. Check the code, or ask the person who manages this workspace."));
  }

  // ---- code entry / inspect failures that have no request ----
  if (state === "ready" && !request) {
    const attempts = error?.code === "device_code_attempts_exceeded";
    const malformed = error?.code === "bad_request" && activeCode.trim() !== "";
    const failed = error && error.code !== "bad_request" && !attempts;
    if (failed) {
      return root(<>
        {errLine("Something went wrong. Try again.")}
        {actions(secondary("Try again", () => h.reload()))}
      </>);
    }
    const mins = Math.max(1, Math.ceil((error?.retryAfter ?? 60) / 60));
    return root(<>
      {title("Connect a device")}
      {note("Enter the code shown on your device.")}
      <form
        className={cx("realmid-device__code-form", k.codeForm)}
        onSubmit={(e: FormEvent) => { e.preventDefault(); setActiveCode(code.trim()); }}
      >
        <label>
          {"Code "}
          <input
            className={cx("realmid-device__code-input", k.codeInput)}
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            placeholder="XXXX-XXXX"
            value={code}
            disabled={attempts}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {malformed && errLine("Check the code. It has 8 letters and numbers, like ABCD-EFGH.")}
        {attempts && errLine(`Too many incorrect codes. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`)}
        {actions(primary("Continue"))}
      </form>
    </>);
  }

  if (state === "loading") return root(note("Checking the code…"), true);

  if (state === "expired") return root(note("This code has expired. Start again on your device to get a new code."));

  if (state === "denied") {
    const reason = request?.failureReason;
    if (reason) {
      const text = REASONS[reason]?.(request!.subjectLabel) ?? `error ${reason}`;
      return root(note(`The device could not connect: ${text}.`));
    }
    return root(note("Request denied. The device was not connected."));
  }

  if (state === "approved") {
    if (signedOut) return root(<>{title("Signed out")}{note("Signed out. The device must ask for a new code to connect again.")}</>);
    if (request?.status === "collected") {
      const from = request.reportedIp ? ` from ${request.reportedIp}` : "";
      const who = request.subjectType === "user" ? "you" : request.subjectLabel;
      if (confirmingSignOut) {
        return root(<>
          {title("Device connected")}
          {note(request.subjectType === "user"
            ? "This signs out the device that just connected."
            : `This signs ${request.subjectLabel} out on every machine, including this one.`)}
          {error && errLine("Something went wrong. Try again.")}
          {actions(
            primary("Sign it out", "button", () => {
              void h.signOut().then((ok) => {
                if (ok) { setSignedOut(true); onDone?.("signed_out"); }
              });
            }),
            secondary("Keep it", () => setConfirmingSignOut(false)),
          )}
        </>);
      }
      return root(<>
        {title("Device connected")}
        {note(`Connected as ${who}${from}.`)}
        {actions(secondary("Not you? Sign it out", () => setConfirmingSignOut(true)))}
      </>);
    }
    return root(<>
      {title("Approved")}
      {note("Waiting for the device to connect. This usually takes a few seconds.")}
      {error && errLine("Something went wrong. Try again.")}
      {actions(secondary("Cancel", denyAction))}
    </>);
  }

  // From here the request exists (ready / needs_mfa).
  const req = request!;

  if (state === "needs_mfa" && h.mfa) {
    const m = h.mfa;
    if (m.kind === "enroll") {
      return root(<>
        {title("Set up an authenticator")}
        {note("Approving a device needs a code from an authenticator app, and your account has none yet. Set one up, then come back to this page; the request stays open until the time runs out.")}
        {actions(
          <a href={enrollHref} className={cx("realmid-device__button realmid-device__button--primary", k.primaryButton)}>Set up an authenticator</a>,
          secondary("Cancel", m.cancel),
        )}
      </>);
    }
    return root(<>
      {title("Confirm it's you")}
      <form
        className={cx("realmid-device__mfa-form", k.mfaForm)}
        onSubmit={(e: FormEvent) => { e.preventDefault(); pending.current = "approved"; void m.submit?.(mfaCode.trim()); }}
      >
        {note("Enter the code from your authenticator app to approve this device.")}
        <label>
          {"Code "}
          <input type="text" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
        </label>
        {error?.code === "mfa_failed" && errLine("That code didn't work. Try again.")}
        {actions(primary("Confirm"), secondary("Cancel", m.cancel))}
      </form>
    </>);
  }

  // ---- ready: request details ----
  const self = req.subjectType === "user";
  const current = auth.tenants.find((t) => t.id === auth.currentTenantId);
  const showWorkspacePicker = self && auth.tenants.length > 1;
  const showRevokeChoice = !req.replaceExistingSessions && !h.sessionLimit;
  const suspended = error?.code === "subject_suspended";
  const sl = h.sessionLimit;

  const row = (label: string, value: ReactNode, aside?: string) => (
    <div className={cx("realmid-device__detail", k.detailRow)}>
      <dt>{label}</dt>
      <dd>{value}{aside ? <> <small>{aside}</small></> : null}</dd>
    </div>
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (sl) { void sl.revokeAndRetry(picked); return; }
    if (suspended) { pending.current = "approved"; void h.retryApprove(); return; }
    // Q3: the choice is stated, never inferred. With the radios shown, nothing is sent until one is picked.
    if (showRevokeChoice && revoke === null) { setNeedChoice(true); return; }
    pending.current = "approved";
    const opts: { tenantId?: string; revokeExistingSessions?: boolean } = {
      revokeExistingSessions: req.replaceExistingSessions ? true : revoke === true,
    };
    if (showWorkspacePicker && tenantPick) opts.tenantId = tenantPick;
    void h.approve(opts);
  };

  const errText = (): string | null => {
    if (!error) return null;
    switch (error.code) {
      case "subject_suspended":
        return `${account} is ${/deactivated/i.test(error.message) ? "deactivated" : "suspended"}. Unsuspend it to connect this device.`;
      case "device_code_attempts_exceeded": {
        const mins = Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60));
        return `Too many incorrect codes. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
      }
      case "session_limit_reached": return null;
      case "tenant_not_member": return "You are not a member of that workspace. Pick another one.";
      default: return "Something went wrong. Try again.";
    }
  };
  const msg = errText();

  return root(<>
    {title(`${app} wants to connect`)}
    <form onSubmit={submit}>
      <dl className={cx("realmid-device__details", k.details)}>
        {row("App", req.clientId ? app : "Not stated by the device")}
        {row("Device name", req.deviceName ?? "Not stated", req.deviceName ? "as typed by the device" : undefined)}
        {row("Device IP", req.reportedIp ?? "Not reported", req.reportedIp ? `reported by ${partnerName}` : undefined)}
        {row("Requested", relative(req.createdAt))}
        {row("Time left", <Countdown expiresAt={req.expiresAt} className={cx("realmid-device__countdown", k.countdown)} />)}
        {row("Signs in as", self ? "You" : req.subjectLabel)}
      </dl>
      {note("Approve only if you started this on your device yourself in the last 10 minutes. The device name was typed by the device and could be anything.")}
      {showWorkspacePicker && (
        <fieldset className={cx("realmid-device__choice", k.choice)}>
          <legend>Which workspace should the device use?</legend>
          {auth.tenants.map((t) => (
            <label key={t.id}>
              <input type="radio" name="realmid-device-tenant" checked={tenantPick === t.id} onChange={() => setTenantPick(t.id)} />
              {` ${t.displayName ?? t.id}`}
            </label>
          ))}
          <label>
            <input type="radio" name="realmid-device-tenant" checked={tenantPick === ""} onChange={() => setTenantPick("")} />
            {" Choose later on the device"}
          </label>
        </fieldset>
      )}
      {!self && current && note(`Workspace: ${current.displayName ?? current.id}`)}
      {showRevokeChoice && (
        <fieldset className={cx("realmid-device__choice", k.choice)}>
          <legend>{`Other sessions of ${account}`}</legend>
          <label>
            <input type="radio" name="realmid-device-revoke" checked={revoke === false} onChange={() => { setRevoke(false); setNeedChoice(false); }} />
            {" Keep them signed in"}
          </label>
          <label>
            <input type="radio" name="realmid-device-revoke" checked={revoke === true} onChange={() => { setRevoke(true); setNeedChoice(false); }} />
            {" Sign them out when this device connects"}
          </label>
          <small>Your current browser session stays signed in.</small>
        </fieldset>
      )}
      {sl && (
        <>
          {note("You're signed in on the most devices this workspace allows. Sign out of one to connect this device.")}
          <ul className={cx("realmid-device__sessions", k.sessionList)}>
            {sl.sessions.map((s) => (
              <li key={s.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(s.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                  />
                  {` ${s.device ?? s.device_name ?? s.id}${s.last_active ?? s.last_seen_at ? `, last active ${new Date(s.last_active ?? s.last_seen_at!).toLocaleString()}` : ""}`}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {needChoice && revoke === null && errLine("Choose whether to sign out the other sessions before approving.")}
      {msg && errLine(msg)}
      {suspended && note("The request stays open, so you can approve it after unsuspending, until the time runs out.")}
      {actions(
        primary(sl ? "Sign out selected and approve" : suspended ? "Try again" : "Approve"),
        secondary("Deny", denyAction),
      )}
    </form>
  </>);
}
