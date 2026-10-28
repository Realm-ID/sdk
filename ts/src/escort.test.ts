import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { FakeIssuer, jsonReply } from "./split-testutil.test.js";

// SPEC14_10_actor (R60): platform token in Authorization, the person/key/SA token in X-User-Token.
// ts form: the actor rides on `realm.withUserToken(jwt)` (and `MeAuth.userToken`); there is no
// per-call bearer. The Go passthrough test has no ts twin: ts has no passthrough surface.

function escortFake(): FakeIssuer {
  const f = new FakeIssuer();
  f.on("/me/contacts", () => jsonReply(200, { items: [] }));
  f.on("/auth/mfa/challenge", () => jsonReply(200, { mfa_challenge_token: "c", methods: ["totp"] }));
  f.on("/auth/sessions", () => jsonReply(200, { items: [] }));
  return f;
}

function checkEscort(f: FakeIssuer, path: string, wantUser: string): void {
  const rs = f.reqs(path);
  assert.ok(rs.length > 0, `${path}: no request reached the issuer`);
  assert.equal(rs[0]!.auth, "Bearer ptok", `${path}: Authorization must be the platform token (R60)`);
  assert.equal(rs[0]!.userToken, wantUser, `${path}: X-User-Token`);
}

test("escort: a me call sends the platform bearer and the user token header (green today, guard)", async () => {
  const f = escortFake();
  await f.realm().me.listContacts({ userToken: "utok" }).page();
  checkEscort(f, "/me/contacts", "utok");
});

test("escort: withUserToken rides in the header on a typed call (mfa challenge, no accessToken field)", async () => {
  const f = escortFake();
  await f.realm().withUserToken("utok2").auth.mintMfaChallenge({} as never);
  checkEscort(f, "/auth/mfa/challenge", "utok2");
});

test("escort: a legacy accessToken on mintMfaChallenge never becomes the bearer", async () => {
  const f = escortFake();
  await f.realm().withUserToken("utok2").auth.mintMfaChallenge({ accessToken: "LEGACY-BEARER" } as never);
  checkEscort(f, "/auth/mfa/challenge", "utok2");
});

test("escort: listSessions escort form, platform bearer plus the actor in X-User-Token", async () => {
  const f = escortFake();
  await f.realm().withUserToken("utok3").auth.listSessions().page();
  checkEscort(f, "/auth/sessions", "utok3");
});

test("escort: a legacy userBearer argument on listSessions never becomes the bearer", async () => {
  const f = escortFake();
  await f.realm().withUserToken("utok3").auth.listSessions("LEGACY-BEARER").page();
  checkEscort(f, "/auth/sessions", "utok3");
});

// R60 removes every mode that puts a user token in the bearer slot. AST scan of non-test source:
// no declaration named userBearer, no `bearer` property on a request-options type, and
// MfaChallengeMintRequest has no accessToken.
test("escort: no user-bearer API remains in the sources", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts"));
  const hits: string[] = [];
  for (const name of files) {
    const sf = ts.createSourceFile(name, readFileSync(new URL(name, dir), "utf8"), ts.ScriptTarget.ES2022, true);
    const visit = (n: ts.Node): void => {
      const nm = (n as { name?: ts.Node }).name;
      const id = nm && ts.isIdentifier(nm) ? nm.text : undefined;
      if (id === "userBearer" && (ts.isPropertySignature(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n))) {
        hits.push(`${name}: ${id} (R60)`);
      }
      if (id === "bearer" && ts.isPropertySignature(n)) hits.push(`${name}: per-call bearer option (R60)`);
      if (ts.isInterfaceDeclaration(n) && n.name.text === "MfaChallengeMintRequest") {
        for (const m of n.members) {
          if (m.name && ts.isIdentifier(m.name) && m.name.text === "accessToken") hits.push(`${name}: MfaChallengeMintRequest.accessToken (R60)`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.ok(files.length >= 50, `examined only ${files.length} source files; the scan is not looking at the package`);
  assert.deepEqual(hits, []);
});
