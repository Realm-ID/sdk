import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import ts from "typescript";

// R27: the partner-half exponentiation (secret d_partner) must be constant-time. Structural guard:
// no variable-time operation is reachable on the secret in cosign.ts / ctexp.ts. The functional check
// is ctexp.test.ts; the empirical one is ctexp.dudect.ts (run by `npm run dudect`).

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.ES2022, true);

function fn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
}

function walk(n: ts.Node, f: (n: ts.Node) => void): void {
  f(n);
  ts.forEachChild(n, (c) => walk(c, f));
}

test("R27: cosign.ts has no BigInt ladder; the partner half goes through ctExp", () => {
  const cs = parse("./cosign.ts");
  assert.equal(fn(cs, "ladderExp"), undefined, "cosign.ts still defines ladderExp (variable-time BigInt ladder, pair[b])");
  const cd = fn(cs, "completeDigest");
  assert.ok(cd, "completeDigest missing");
  let usesCT = false;
  walk(cd!, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "ctExp") usesCT = true;
  });
  assert.ok(usesCT, "completeDigest does not call ctExp for the partner half");
  // The only BigInt exponentiation left is the PUBLIC verify (modPowPublic); nothing may use ** .
  walk(cs, (n) => {
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        n.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)) {
      assert.fail("cosign.ts uses ** (BigInt exponentiation)");
    }
  });
});

test("R27: ctexp.ts secret path is BigInt-free, ** -free and never indexes the table by the digit", () => {
  const ct = parse("./ctexp.ts");
  for (const name of ["ctMontMul", "ctExpLimbs"]) {
    const f = fn(ct, name);
    assert.ok(f, `ctexp.ts must define ${name}`);
    walk(f!, (n) => {
      if (ts.isIdentifier(n) && n.text === "BigInt") assert.fail(`${name} uses BigInt`);
      if (n.kind === ts.SyntaxKind.BigIntLiteral) assert.fail(`${name} uses a bigint literal`);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) assert.fail(`${name} uses **`);
      if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.argumentExpression) &&
          ["win", "digit", "b", "bit"].includes(n.argumentExpression.text)) {
        assert.fail(`${name} indexes by secret-derived ${n.argumentExpression.text}`);
      }
      if (ts.isPropertyAccessExpression(n) && ["modPow", "pow"].includes(n.name.text)) assert.fail(`${name} calls ${n.name.text}`);
    });
  }
  // The scan loop must visit every table entry: it indexes the table by the loop counter.
  const f = fn(ct, "ctExpLimbs")!;
  let scans = false;
  walk(f, (n) => {
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "table" &&
        ts.isIdentifier(n.argumentExpression) && n.argumentExpression.text === "i") scans = true;
  });
  assert.ok(scans, "ctExpLimbs does not scan the window table by the loop counter");
});
