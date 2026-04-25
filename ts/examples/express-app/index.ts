/**
 * Minimal Express server using @realmid/sdk middleware.
 *
 * Routes:
 *   POST /login   — handled entirely by SDK middleware; sets refresh cookie
 *   POST /logout  — handled entirely by SDK middleware; clears refresh cookie
 *   POST /token   — refresh-token rotation + tenant switch
 *   POST /mfa/verify — MFA challenge completion
 *   GET  /me      — protected; returns the verified Claims attached by SDK
 *   GET  /health  — exempt; always 200
 *
 * Run:
 *   REALM_ID=01HXYZ... API_KEY=rk_live_... npm run start
 */

import express from "express";
import { createRealm } from "@realmid/sdk";

const realmId = process.env["REALM_ID"];
const apiKey = process.env["API_KEY"];
if (!realmId) {
  console.error("REALM_ID env var is required");
  process.exit(1);
}

const realm = createRealm({
  realmId,
  apiKey,
  baseUrl: process.env["REALMID_BASE_URL"] ?? "https://auth.realmid.dev",
});

const app = express();
app.use(express.json());

app.use(realm.middleware({
  exemptPaths: ["/health", "/public/*"],
  cookieSecure: process.env["NODE_ENV"] === "production",
}));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/me", (req, res) => {
  // Middleware attached the verified Claims to req.realmid.
  const claims = (req as unknown as { realmid?: unknown }).realmid;
  res.json({ claims });
});

const port = Number(process.env["PORT"] ?? 3000);
app.listen(port, () => {
  console.log(`realmid-example listening on :${port}`);
});
