# `<DeviceApproval/>` — the rendered device-approval page (`@realm-id/web-react` 0.6.0, NOT BUILT, UNRELEASED)

Contract for the component that SPEC §15.10 points at. It is built only on `useDeviceApproval`
(SPEC §15.9), which calls `realm.device.*` (SPEC §15.8) against the partner BFF's browser routes
(`web/BFF-SPEC.md` § Device approval), which the `sdk/go` handler set serves (SPEC §15.1).

Rulings this file implements: N1 (owner, 2026-11-02: a rendered component, so a partner's UI does not
rebuild the page; RealmID's ui mounts it); the styling ruling (owner, 2026-11-02, /away batch: plain
semantic markup, stable documented class names per part, a `className` prop per part, an OPTIONAL default
stylesheet driven only by CSS custom properties, no Tailwind); Q2, Q3, Q6, Q7, N5, DQ1, DQ2 (umbrella plan
`plans/2026-11-02-device-code-service-account.md` § 6 and § 5.3). Base copy: that plan's § 4.

## 1. Mounting

```tsx
import { DeviceApproval } from "@realm-id/web-react";
import "@realm-id/web-react/device-approval.css"; // optional

<DeviceApproval
  initialCode={new URLSearchParams(location.search).get("code") ?? ""}
  partnerName="Traide"              // used in "reported by <partnerName>"
  enrollHref="/account#security"    // REQUIRED: where a person with no MFA factor sets one up (4.7)
  appLabels={{ "traide-sync": "Traide sync agent" }} // client_id -> label; unknown ids show as typed
  classNames={{ root: "my-page", primaryButton: "btn btn-primary" }}
  workspaces={[{ id: "t1", displayName: "Acme" }]} // optional: ordered picker list; exactly one = pinned (4.4)
  defaultTenantId="t1"              // optional: preselected workspace (4.4)
  onDone={(outcome) => {}}          // "approved" | "denied" | "signed_out"
/>
```

The page must be signed in: the component renders inside the partner's `RealmProvider` with a session.
Signing in, and returning to the same `?code=` afterwards, is the host page's job (for RealmID: ui
`docs/device-approval-screens.md`, wave W1c).

## 2. Parts, class names, `className` props

Every part is plain semantic HTML with ONE stable class, prefixed `realmid-device`. The class names are a
public contract: renaming one is a breaking change of `@realm-id/web-react`. Each part also takes an extra
class through `classNames.<part>`, appended, never replacing the stable one.

| part (`classNames` key) | element | class |
|---|---|---|
| `root` | `<section aria-live="polite">` | `realmid-device` |
| `title` | `<h1>` | `realmid-device__title` |
| `codeForm` | `<form>` | `realmid-device__code-form` |
| `codeInput` | `<input inputmode="text" autocomplete="one-time-code">` | `realmid-device__code-input` |
| `details` | `<dl>` | `realmid-device__details` |
| `detailRow` | `<div>` holding `<dt>`/`<dd>` | `realmid-device__detail` |
| `notice` | `<p>` | `realmid-device__notice` |
| `choice` | `<fieldset>` | `realmid-device__choice` |
| `sessionList` | `<ul>` | `realmid-device__sessions` |
| `mfaForm` | `<form>` | `realmid-device__mfa-form` |
| `actions` | `<div>` | `realmid-device__actions` |
| `primaryButton` | `<button type="submit">` | `realmid-device__button realmid-device__button--primary` |
| `secondaryButton` | `<button type="button">` | `realmid-device__button realmid-device__button--secondary` |
| `error` | `<p role="alert">` | `realmid-device__error` |
| `countdown` | `<time>` | `realmid-device__countdown` |

The root also carries `data-state="<hook state>"` so a stylesheet can target a state without new classes.

## 3. Optional default stylesheet

`@realm-id/web-react/device-approval.css`, a separate import (nothing is injected at runtime). It reads
ONLY these custom properties, each with a fallback, so a partner themes it without overriding selectors:

`--realmid-accent` (primary button, focus ring), `--realmid-accent-contrast` (text on the accent),
`--realmid-text`, `--realmid-muted`, `--realmid-surface`, `--realmid-border`, `--realmid-danger`,
`--realmid-radius`, `--realmid-font`, `--realmid-gap`.

No Tailwind, no CSS-in-JS and no CSS framework appear in `web/packages/react/package.json` (a test checks
it). RealmID's ui styles the component through the same `classNames` slots and custom properties.

## 4. Every state, with its copy

`<partner>` = the `partnerName` prop. `<app>` = `appLabels[clientId]`, else the raw `clientId`, else
"An app". `<device>` = the device name as sent. `<account>` = `request.subjectLabel`.

### 4.1 Code entry (no code yet, or `error.code = "bad_request"` from a malformed code)
- Title: "Connect a device"
- Body: "Enter the code shown on your device."
- Input placeholder: "XXXX-XXXX". Button: "Continue".
- Malformed code: "Check the code. It has 8 letters and numbers, like ABCD-EFGH."

### 4.2 Loading (`loading`)
- "Checking the code…" (no buttons; the root has `aria-busy="true"`).

### 4.3 Request details (`ready`)
- Title: "<app> wants to connect"
- Details list:
  - "App": `<app>`. When `clientId` is absent: "Not stated by the device". No "verified" mark ever: a
    `client_id` confers no authority (N5).
  - "Device name": `<device>`, with the label "as typed by the device" beside it. Absent: "Not stated".
  - "Device IP": `request.reportedIp`, with the label "reported by <partner>" (Q6). Absent: "Not reported".
  - "Requested": the relative time of `createdAt` ("2 minutes ago").
  - "Time left": a live countdown to `expiresAt` ("7:42 left").
  - "Signs in as": `<account>` (bot case) or "You" (self case).
- Notice (plan § 4): "Approve only if you started this on your device yourself in the last 10 minutes.
  The device name was typed by the device and could be anything."
- **Never** compare the device IP with this browser's IP and never show a warning that they differ (Q6,
  owner 2026-11-02: the device is usually somewhere else). There is no such code path in the component.

### 4.4 Account and workspace choice (`ready`, self case, approver in more than one workspace)
- Legend: "Which workspace should the device use?"
- One radio per membership (display name), plus "Choose later on the device" (sends no `tenantId`; R41).
- Host control (R41 amendment, R-CLI1; both props optional): `workspaces` is an ordered list that replaces
  the realm's order in the picker (RealmID's ui passes the base tenant last); `defaultTenantId` preselects
  one radio. With EXACTLY ONE `workspaces` entry the approval is PINNED: no picker, and that `tenantId` is
  sent. Without the props the picker lists the realm's memberships and sends no `tenantId` unless one is
  picked.
- Bot case: no picker. A line instead: "Workspace: <current workspace name>" (the bot lives in the
  approver's current workspace, ADR-122 D1).

### 4.5 "Sign out other sessions" choice (`ready`; HIDDEN when `request.replaceExistingSessions` is true)
- Legend: "Other sessions of <account>"
- Radios (no default selected; one must be picked, Q3 "stated, never inferred"):
  - "Keep them signed in"
  - "Sign them out when this device connects" — helper: "Your current browser session stays signed in."
- Under `ReplaceExistingSessions` (Traide) nothing is shown and the BFF always sends `true`.

### 4.6 Approve / refuse (`ready`)
- Primary: "Approve". Secondary: "Deny".
- Deny asks nothing further and moves to 4.12.

### 4.7 Fresh MFA (`needs_mfa`) — always inside the card
The step-up is rendered in this card and never handed to a host-wide prompt: `realm.device.*` calls opt
out of `withStepUpRetry` (SPEC §15.8), so a host's global step-up modal does not fire for them.
- `mfa.kind === "verify"`: Title "Confirm it's you". Body "Enter the code from your authenticator app to
  approve this device." Input + "Confirm" / "Cancel". "Confirm" is disabled until a code is typed (R41).
- `mfa.kind === "enroll"` (ADR-096 D4 `412 mfa_registration_required`, or a verify challenge with an empty
  token): Title "Set up an authenticator". Body "Approving a device needs a code from an authenticator
  app, and your account has none yet. Set one up, then come back to this page; the request stays open
  until the time runs out." A link (`<a class="realmid-device__button realmid-device__button--primary">`)
  "Set up an authenticator" to the `enrollHref` prop, plus "Cancel". `enrollHref` is a required prop, so
  this state is never a dead end.
- A wrong code: "That code didn't work. Try again."

### 4.8 At the session limit (`ready`, `error.code = "session_limit_reached"`, self case, Q3)
- Notice: "You're signed in on the most devices this workspace allows. Sign out of one to connect this
  device."
- `sessionList`: one row per `sessionLimit.sessions` entry (device, last active), each with a checkbox.
- Primary: "Sign out selected and approve" (calls `sessionLimit.revokeAndRetry(ids)`). Secondary: "Deny".

### 4.9 Suspended or deactivated bot (`ready`, `error.code = "subject_suspended"`, DQ2)
- Error: "<account> is suspended. Unsuspend it to connect this device." (deactivated reads "is
  deactivated").
- Body: "The request stays open, so you can approve it after unsuspending, until the time runs out."
- Buttons: "Try again" (re-runs approve) and "Deny". Approving never reactivates the account.

### 4.10 Too many codes (`error.code = "device_code_attempts_exceeded"`, Q2)
- Error: "Too many incorrect codes. Try again in <n> minutes." (`n` from `error.retryAfter`, rounded up).
- The code input is disabled until the time passes.

### 4.11 Approved (`approved`)
- Waiting (`request.status === "approved"`): Title "Approved". Body "Waiting for the device to connect.
  This usually takes a few seconds." Secondary: "Cancel" (deny before collection, Q7).
- Connected (`request.status === "collected"`, Q7): Title "Device connected". Body "Connected as
  <account> from <reportedIp>." Link-styled secondary button: "Not you? Sign it out".
  - Confirmation before sign-out, bot case (DQ1): "This signs <account> out on every machine, including
    this one." Self case: "This signs out the device that just connected." Buttons "Sign it out" /
    "Keep it".
  - After sign-out: "Signed out. The device must ask for a new code to connect again."

### 4.12 Denied (`denied`)
- "Request denied. The device was not connected."
- When `request.failureReason` is set (a failure at collection): "The device could not connect:
  <reason text>." Reason texts: `subject_suspended` -> "<account> was suspended before the device
  connected"; `user_suspended` -> "your account is suspended in this workspace"; `tenant_disabled` -> "this
  workspace is disabled"; `session_limit_reached` -> "the session limit was reached"; anything else ->
  "error <code>".

### 4.13 Expired (`expired`)
- "This code has expired. Start again on your device to get a new code."

### 4.14 Not found and not allowed (`not_found`, `not_owner`) — ONE copy (Q2)
- "We couldn't find a request you can approve with this code. Check the code, or ask the person who
  manages this workspace."
- Both states render byte-identical text and markup (a test asserts it): Q2 makes an unknown code and a
  request you cannot act on the same answer, and the page must not undo that.

### 4.15 Other errors
- Network or `server_error`: "Something went wrong. Try again." with "Try again".
- `device_approval_not_allowed` is the `not_owner` state (4.14), not an error line.

## 5. Accessibility

The root is an `aria-live="polite"` region so state changes are announced; errors use `role="alert"`;
the countdown is a `<time datetime>` updated at most once per second and announced only at 1 minute left.
Every input has a visible `<label>`.
