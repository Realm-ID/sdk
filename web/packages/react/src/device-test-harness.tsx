/**
 * Test harness for the device hook and component tests (W2-sdk). It is the ONLY file that knows how React is
 * rendered under node: `react-dom/client` + `jsdom` (new devDependencies, owner question 1 of the W2-sdk
 * return). Swap the renderer here and every device test follows.
 */

import { JSDOM } from "jsdom";
import { createElement, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as ReactPkg from "./index.js";

export const R = ReactPkg as unknown as Record<string, any>;

export interface FakeDevice {
  inspect: (code: string) => Promise<any>;
  approve: (req: any) => Promise<any>;
  completeStepUp: (challenge: any, code: string) => Promise<void>;
  deny: (code: string) => Promise<any>;
  signOut: (code: string) => Promise<any>;
}

export interface Calls {
  inspect: string[];
  approve: any[];
  completeStepUp: Array<{ challenge: any; code: string }>;
  deny: string[];
  signOut: string[];
  fetch: string[];
}

export function realmErr(code: string, status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { name: "RealmError", code, status, ...extra });
}

export const VERIFY = { kind: "verify", challengeToken: "CHAL", methods: ["totp"], reason: "fresh_required", maxAgeSeconds: 300 };
export const ENROLL = { kind: "enroll", challengeToken: "CHAL", methods: ["totp"], reason: "no_mfa", maxAgeSeconds: 0 };

export function view(extra: Record<string, unknown> = {}) {
  return {
    id: "da1", status: "pending", clientId: "traide-sync", deviceName: "build-box", deviceNameSource: "client_declared",
    reportedIp: "203.0.113.9", reportedIpSource: "partner",
    createdAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    subjectType: "service", subjectLabel: "sync-bot in Acme", replaceExistingSessions: false, stepUp: true,
    ...extra,
  };
}

/** A realm double: only what RealmProvider and useDeviceApproval touch. */
export function fakeRealm(over: Partial<FakeDevice> = {}, tenants: any[] = [{ id: "t1", displayName: "Acme", role: "owner" }]) {
  const calls: Calls = { inspect: [], approve: [], completeStepUp: [], deny: [], signOut: [], fetch: [] };
  const device: FakeDevice = {
    inspect: async (c) => { calls.inspect.push(c); return view(); },
    approve: async (r) => { calls.approve.push(r); return { id: "da1", status: "approved", subjectType: "service", expiresAt: "x" }; },
    completeStepUp: async (challenge, code) => { calls.completeStepUp.push({ challenge, code }); },
    deny: async (c) => { calls.deny.push(c); return { id: "da1", status: "denied" }; },
    signOut: async (c) => { calls.signOut.push(c); return { subjectType: "service", scope: "account" }; },
  };
  for (const k of Object.keys(over) as Array<keyof FakeDevice>) {
    const fn = over[k] as (...a: any[]) => Promise<any>;
    (device as any)[k] = async (...a: any[]) => {
      (calls as any)[k].push(k === "completeStepUp" ? { challenge: a[0], code: a[1] } : a[0]);
      return fn(...a);
    };
  }
  const state = { status: "authenticated", user: { id: "u1", email: "u@x" }, tenants, currentTenantId: "t1" };
  const realm = {
    device,
    getState: () => state,
    onAuthChange: () => () => {},
    ready: async () => {},
    fetch: async (url: string) => { calls.fetch.push(String(url)); return new Response(JSON.stringify({ items: [] }), { status: 200 }); },
  };
  return { realm, calls };
}

let dom: JSDOM | null = null;

export function setupDom(): void {
  if (dom) return;
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.test/device?code=ABCD-EFGH" });
  const g = globalThis as any;
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

export interface Mounted { root: Root; container: HTMLElement; unmount: () => Promise<void>; text: () => string; html: () => string; }

/** Flush effects and resolved promises a few rounds (inspect -> state -> re-render). */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

export async function mount(el: ReactElement): Promise<Mounted> {
  setupDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  return {
    root, container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
    text: () => container.textContent ?? "",
    html: () => container.innerHTML,
  };
}

export function withRealm(realm: unknown, child: ReactElement): ReactElement {
  return createElement(R.RealmProvider, { realm }, child);
}

/** Mount a component that renders the hook's result into `out.current` on every render. */
export async function mountHook(realm: unknown, userCode: string) {
  const out: { current: any } = { current: null };
  function Probe() { out.current = R.useDeviceApproval(userCode); return null; }
  const m = await mount(withRealm(realm, createElement(Probe)));
  return { out, ...m };
}

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("click: element not found");
  await act(async () => { el.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle(3);
}

export function button(m: Mounted, label: string): HTMLElement | null {
  return Array.from(m.container.querySelectorAll("button, a")).find((b) => (b.textContent ?? "").trim() === label) as HTMLElement | null;
}
