import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RealmError } from "./errors.js";
import { ActorRequiredError, isActorRequired } from "./actor-required.js";
import * as sdk from "./index.js";
import { FakeIssuer, jsonReply } from "./split-testutil.test.js";

// SPEC14_10_actor / R86: ONE typed error for the SDK's local refusal and the server's
// 403 actor_required. ts: class ActorRequiredError extends RealmError (code "actor_required"),
// predicate isActorRequired(e), both exported from the package entry point.

function assertActorRequired(what: string, err: unknown): void {
  assert.ok(err instanceof ActorRequiredError, `${what}: not an ActorRequiredError: ${String(err)}`);
  assert.ok(err instanceof RealmError, `${what}: not a RealmError`);
  assert.equal((err as RealmError).code, "actor_required", `${what}: code`);
  assert.equal(isActorRequired(err), true, `${what}: isActorRequired`);
  assert.match((err as Error).message, /X-User-Token/, `${what}: message lacks the X-User-Token hint`);
}

const catching = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e) => e);

test("actor-required: the server's 403 actor_required decodes to the typed error and keeps HTTP 403", async () => {
  const f = new FakeIssuer();
  f.on("/tenants/t1", () => jsonReply(403, { error: { code: "actor_required", message: "needs an actor" } }));
  const err = await catching(f.realm().tenants.get("t1"));
  assertActorRequired("server 403", err);
  assert.equal((err as RealmError).httpStatus, 403);
});

test("actor-required: the local refusal is the same typed error and sends nothing (R61)", async () => {
  const f = new FakeIssuer();
  f.on("/me/contacts", () => jsonReply(200, { items: [] }));
  f.on("/auth/sessions", () => jsonReply(200, { items: [] }));
  const r = f.realm();
  // no userToken, no withUserToken: a bare platform call on an actor route
  assertActorRequired("local refusal (me)", await catching(r.me.listContacts({}).page()));
  assert.equal(f.reqs("/me/contacts").length, 0, "local refusal still sent a request to /me/contacts");
  assertActorRequired("local refusal (sessions)", await catching(r.auth.listSessions().page()));
  assert.equal(f.reqs("/auth/sessions").length, 0, "local refusal still sent a request to /auth/sessions");
});

test("actor-required: the predicate is safe and sees through cause wrapping", () => {
  assert.equal(isActorRequired(undefined), false);
  assert.equal(isActorRequired(null), false);
  assert.equal(isActorRequired(new Error("x")), false);
  assert.equal(isActorRequired(new RealmError({ code: "bad_request", message: "x" })), false);
  const typed = new ActorRequiredError({ message: "needs X-User-Token", httpStatus: 403 });
  assert.equal(isActorRequired(typed), true);
  assert.equal(isActorRequired(new Error("job failed", { cause: typed })), true, "false through cause wrapping");
  assert.equal(typed.code, "actor_required");
});

test("actor-required: class and predicate are exported from the package entry point", () => {
  assert.equal(typeof (sdk as Record<string, unknown>).ActorRequiredError, "function");
  assert.equal(typeof (sdk as Record<string, unknown>).isActorRequired, "function");
});
