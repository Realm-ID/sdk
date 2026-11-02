/**
 * RED tests for `<DeviceApproval/>` (SPEC §15.10, docs/device-approval-component.md). Copy strings are the
 * doc's § 4 verbatim. They fail on the missing component (`R.DeviceApproval` is undefined).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { mount, withRealm, fakeRealm, realmErr, view, settle, click, button, R, VERIFY, ENROLL, type Mounted } from "./device-test-harness.js";

const CODE = "ABCD-EFGH";
type Over = Parameters<typeof fakeRealm>[0];

async function page(over: Over = {}, props: Record<string, unknown> = {}, tenants?: any[]) {
  const f = fakeRealm(over, tenants);
  const m = await mount(withRealm(f.realm, createElement(R.DeviceApproval, {
    initialCode: CODE, partnerName: "Traide", enrollHref: "/account#security",
    appLabels: { "traide-sync": "Traide sync agent" }, ...props,
  })));
  await settle();
  return { ...f, m };
}

const root = (m: Mounted) => m.container.querySelector("section") as HTMLElement;

test("no code yet: code-entry screen", async () => {
  const f = fakeRealm();
  const m = await mount(withRealm(f.realm, createElement(R.DeviceApproval, { partnerName: "Traide", enrollHref: "/e" })));
  await settle();
  assert.match(m.text(), /Connect a device/);
  assert.match(m.text(), /Enter the code shown on your device\./);
  const input = m.container.querySelector("input.realmid-device__code-input") as HTMLInputElement;
  assert.equal(input?.getAttribute("placeholder"), "XXXX-XXXX");
  assert.ok(button(m, "Continue"));
  assert.equal(f.calls.inspect.length, 0);
});

test("loading: 'Checking the code…' and aria-busy", async () => {
  const f = fakeRealm({ inspect: () => new Promise(() => {}) });
  const m = await mount(withRealm(f.realm, createElement(R.DeviceApproval, { initialCode: CODE, partnerName: "Traide", enrollHref: "/e" })));
  await settle(2);
  assert.match(m.text(), /Checking the code…/);
  assert.equal(root(m).getAttribute("aria-busy"), "true");
});

test("ready: title, labelled details, notice, buttons; app label, raw client id, and absent client id", async () => {
  const { m } = await page();
  const t = m.text();
  assert.match(t, /Traide sync agent wants to connect/);
  assert.match(t, /build-box/);
  assert.match(t, /as typed by the device/);
  assert.match(t, /203\.0\.113\.9/);
  assert.match(t, /reported by Traide/);
  assert.match(t, /Signs in as/);
  assert.match(t, /sync-bot in Acme/);
  assert.match(t, /Approve only if you started this on your device yourself in the last 10 minutes\. The device name was typed by the device and could be anything\./);
  assert.match(t, /\d+:\d\d left/);
  assert.ok(button(m, "Approve") && button(m, "Deny"));

  const raw = await page({ inspect: async () => view({ clientId: "mystery-app" }) });
  assert.match(raw.m.text(), /mystery-app wants to connect/);
  const none = await page({ inspect: async () => view({ clientId: undefined, deviceName: undefined, reportedIp: undefined }) });
  assert.match(none.m.text(), /Not stated by the device/);
  assert.match(none.m.text(), /Not stated/);
  assert.match(none.m.text(), /Not reported/);
  assert.match(none.m.text(), /An app wants to connect/);
});

test("the IP is never compared and no mismatch warning exists (Q6)", async () => {
  const { m } = await page();
  assert.doesNotMatch(m.text(), /differ|mismatch|different|does not match|doesn't match|not the same/i);
  assert.equal(m.container.querySelector("[role=alert]"), null);
});

test("self case reads 'You'", async () => {
  const { m } = await page({ inspect: async () => view({ subjectType: "user", subjectLabel: "you" }) });
  assert.match(m.text(), /Signs in as/);
  assert.match(m.text(), /You/);
});

test("stable class per part, data-state on the root, aria-live", async () => {
  const { m } = await page();
  const r = root(m);
  assert.ok(r.classList.contains("realmid-device"));
  assert.equal(r.getAttribute("aria-live"), "polite");
  assert.equal(r.getAttribute("data-state"), "ready");
  for (const sel of ["h1.realmid-device__title", "dl.realmid-device__details", ".realmid-device__detail", "p.realmid-device__notice",
    ".realmid-device__actions", "button.realmid-device__button.realmid-device__button--primary",
    "button.realmid-device__button.realmid-device__button--secondary", "time.realmid-device__countdown"]) {
    assert.ok(m.container.querySelector(sel), `missing part ${sel}`);
  }
  assert.equal(button(m, "Approve")?.getAttribute("type"), "submit");
  assert.equal(button(m, "Deny")?.getAttribute("type"), "button");
});

test("classNames append to the stable class, never replace it", async () => {
  const { m } = await page({}, { classNames: { root: "my-page", title: "my-title", primaryButton: "btn btn-primary", secondaryButton: "btn-2", notice: "n", details: "d", actions: "a" } });
  const has = (sel: string, ...cls: string[]) => { const e = m.container.querySelector(sel); return !!e && cls.every((c) => e.classList.contains(c)); };
  assert.ok(has("section", "realmid-device", "my-page"));
  assert.ok(has("h1", "realmid-device__title", "my-title"));
  assert.ok(has("button[type=submit]", "realmid-device__button", "realmid-device__button--primary", "btn", "btn-primary"));
  assert.ok(has("button[type=button]", "realmid-device__button--secondary", "btn-2"));
  assert.ok(has("p.realmid-device__notice", "n"));
  assert.ok(has("dl", "realmid-device__details", "d"));
  assert.ok(has(".realmid-device__actions", "a"));
});

test("Q3 choice: two radios, none selected, shown when the BFF does not force replacement", async () => {
  const { m } = await page();
  assert.match(m.text(), /Other sessions of sync-bot in Acme/);
  assert.match(m.text(), /Keep them signed in/);
  assert.match(m.text(), /Sign them out when this device connects/);
  assert.match(m.text(), /Your current browser session stays signed in\./);
  const radios = Array.from(m.container.querySelectorAll("fieldset.realmid-device__choice input[type=radio]")) as HTMLInputElement[];
  assert.ok(radios.length >= 2);
  assert.ok(radios.every((r) => !r.checked), "no default may be selected (Q3: stated, never inferred)");
});

test("Q3 choice is HIDDEN under ReplaceExistingSessions", async () => {
  const { m } = await page({ inspect: async () => view({ replaceExistingSessions: true }) });
  assert.doesNotMatch(m.text(), /Keep them signed in/);
  assert.doesNotMatch(m.text(), /Sign them out when this device connects/);
});

test("self case with several workspaces: a picker, plus 'Choose later on the device'; bot case: a workspace line", async () => {
  const two = [{ id: "t1", displayName: "Acme", role: "owner" }, { id: "t2", displayName: "Beta", role: "member" }];
  const self = await page({ inspect: async () => view({ subjectType: "user", subjectLabel: "you" }) }, {}, two);
  assert.match(self.m.text(), /Which workspace should the device use\?/);
  assert.match(self.m.text(), /Choose later on the device/);
  const bot = await page({}, {}, two);
  assert.match(bot.m.text(), /Workspace: Acme/);
  assert.doesNotMatch(bot.m.text(), /Which workspace should the device use\?/);
});

test("Approve calls realm.device.approve with the code; Deny moves to the denied screen", async () => {
  const a = await page({ inspect: async () => view({ replaceExistingSessions: true }) });
  await click(button(a.m, "Approve"));
  assert.equal(a.calls.approve.length, 1);
  assert.equal(a.calls.approve[0].userCode, CODE);
  assert.equal(root(a.m).getAttribute("data-state"), "approved");
  const d = await page();
  await click(button(d.m, "Deny"));
  assert.deepEqual(d.calls.deny, [CODE]);
  assert.match(d.m.text(), /Request denied\. The device was not connected\./);
});

test("fresh MFA (verify) is rendered IN the card", async () => {
  const { m, calls } = await page({ approve: async () => { throw realmErr("mfa_required", 412, { details: { stepUp: VERIFY } }); } }, {});
  await click(button(m, "Approve"));
  assert.match(m.text(), /Confirm it's you/);
  assert.match(m.text(), /Enter the code from your authenticator app to approve this device\./);
  assert.ok(button(m, "Confirm") && button(m, "Cancel"));
  assert.ok(m.container.querySelector("form.realmid-device__mfa-form"));
  assert.ok(calls.approve.length >= 1);
});

test("fresh MFA (enroll): explanation, a link to enrollHref, Cancel; never a dead end", async () => {
  const { m } = await page({ approve: async () => { throw realmErr("mfa_registration_required", 412, { details: { stepUp: ENROLL } }); } }, {});
  await click(button(m, "Approve"));
  assert.match(m.text(), /Set up an authenticator/);
  assert.match(m.text(), /Approving a device needs a code from an authenticator app, and your account has none yet\./);
  const link = m.container.querySelector("a.realmid-device__button--primary") as HTMLAnchorElement;
  assert.equal(link?.getAttribute("href"), "/account#security");
  assert.ok(button(m, "Cancel"));
});

test("session limit: notice, a row per session with a checkbox, 'Sign out selected and approve'", async () => {
  const { m } = await page({
    inspect: async () => view({ subjectType: "user", subjectLabel: "you", replaceExistingSessions: true }),
    approve: async () => { throw realmErr("session_limit_reached", 412, { details: { revocation_token: "RV", sessions: [{ id: "s1", device: "Mac", last_active: "2026-11-03T00:00:00Z" }, { id: "s2", device: "Pixel", last_active: "2026-11-02T00:00:00Z" }] } }); },
  });
  await click(button(m, "Approve"));
  assert.match(m.text(), /You're signed in on the most devices this workspace allows\. Sign out of one to connect this device\./);
  const items = m.container.querySelectorAll("ul.realmid-device__sessions li");
  assert.equal(items.length, 2);
  assert.equal(m.container.querySelectorAll("ul.realmid-device__sessions input[type=checkbox]").length, 2);
  assert.ok(button(m, "Sign out selected and approve") && button(m, "Deny"));
});

test("suspended bot (DQ2): error line, request stays open, 'Try again' re-runs approve", async () => {
  let n = 0;
  const { m, calls } = await page({
    inspect: async () => view({ replaceExistingSessions: true }),
    approve: async () => { n += 1; if (n === 1) throw realmErr("subject_suspended", 409); return { id: "da1", status: "approved", subjectType: "service", expiresAt: "x" }; },
  });
  await click(button(m, "Approve"));
  assert.match(m.text(), /sync-bot in Acme is suspended\. Unsuspend it to connect this device\./);
  assert.match(m.text(), /The request stays open, so you can approve it after unsuspending, until the time runs out\./);
  assert.ok(m.container.querySelector("p.realmid-device__error[role=alert]"));
  await click(button(m, "Try again"));
  assert.equal(calls.approve.length, 2);
});

test("too many codes: minutes rounded up from retryAfter, code input disabled", async () => {
  const { m } = await page({ inspect: async () => { throw realmErr("device_code_attempts_exceeded", 429, { retryAfter: 61, details: { retryAfter: 61 } }); } });
  assert.match(m.text(), /Too many incorrect codes\. Try again in 2 minutes\./);
  const input = m.container.querySelector("input.realmid-device__code-input") as HTMLInputElement | null;
  assert.ok(input?.disabled, "the code input must be disabled until the time passes");
});

test("approved-waiting and device-connected screens (Q7), with the DQ1 confirmation copy", async () => {
  const wait = await page({ inspect: async () => view({ status: "approved" }) });
  assert.match(wait.m.text(), /Approved/);
  assert.match(wait.m.text(), /Waiting for the device to connect\. This usually takes a few seconds\./);
  assert.ok(button(wait.m, "Cancel"));

  const bot = await page({ inspect: async () => view({ status: "collected", collectedSessionId: "sx" }) });
  assert.match(bot.m.text(), /Device connected/);
  assert.match(bot.m.text(), /Connected as sync-bot in Acme from 203\.0\.113\.9\./);
  await click(button(bot.m, "Not you? Sign it out"));
  assert.match(bot.m.text(), /This signs sync-bot in Acme out on every machine, including this one\./);
  assert.ok(button(bot.m, "Sign it out") && button(bot.m, "Keep it"));
  await click(button(bot.m, "Sign it out"));
  assert.deepEqual(bot.calls.signOut, [CODE]);
  assert.match(bot.m.text(), /Signed out\. The device must ask for a new code to connect again\./);

  const self = await page({ inspect: async () => view({ status: "collected", subjectType: "user", subjectLabel: "you", collectedSessionId: "sx" }) });
  await click(button(self.m, "Not you? Sign it out"));
  assert.match(self.m.text(), /This signs out the device that just connected\./);
});

test("denied with a failure reason, with the doc's reason texts", async () => {
  const cases: Array<[string, RegExp]> = [
    ["subject_suspended", /The device could not connect: sync-bot in Acme was suspended before the device connected\./],
    ["user_suspended", /your account is suspended in this workspace/],
    ["tenant_disabled", /this workspace is disabled/],
    ["session_limit_reached", /the session limit was reached/],
    ["weird_code", /error weird_code/],
  ];
  for (const [reason, re] of cases) {
    const { m } = await page({ inspect: async () => view({ status: "failed", failureReason: reason }) });
    assert.match(m.text(), re, reason);
  }
});

test("expired copy", async () => {
  const { m } = await page({ inspect: async () => view({ status: "expired" }) });
  assert.match(m.text(), /This code has expired\. Start again on your device to get a new code\./);
});

test("not_found and not_owner render BYTE-IDENTICAL text and markup inside the root (Q2)", async () => {
  const nf = await page({ inspect: async () => { throw realmErr("forbidden", 403); } });
  const no = await page({ inspect: async () => { throw realmErr("device_approval_not_allowed", 403); } });
  assert.match(nf.m.text(), /We couldn't find a request you can approve with this code\. Check the code, or ask the person who manages this workspace\./);
  const strip = (m: Mounted) => root(m).outerHTML.replace(/ data-state="[^"]*"/, "");
  assert.equal(strip(nf.m), strip(no.m));
});

test("other errors: 'Something went wrong. Try again.' with a retry button", async () => {
  const { m } = await page({ inspect: async () => { throw realmErr("server_error", 500); } });
  assert.match(m.text(), /Something went wrong\. Try again\./);
  assert.ok(button(m, "Try again"));
});

test("onDone reports approved, denied and signed_out", async () => {
  const seen: string[] = [];
  const a = await page({ inspect: async () => view({ replaceExistingSessions: true }) }, { onDone: (o: string) => seen.push(o) });
  await click(button(a.m, "Approve"));
  const d = await page({}, { onDone: (o: string) => seen.push(o) });
  await click(button(d.m, "Deny"));
  const s = await page({ inspect: async () => view({ status: "collected", collectedSessionId: "sx" }) }, { onDone: (o: string) => seen.push(o) });
  await click(button(s.m, "Not you? Sign it out"));
  await click(button(s.m, "Sign it out"));
  assert.deepEqual(seen, ["approved", "denied", "signed_out"]);
});
