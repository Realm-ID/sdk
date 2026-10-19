# BACKLOG — sdk/

Decided real work, not for now. See [`TODO.md`](TODO.md) for open, actionable items.

## Register the `details.server_code` error codes (owner, 2026-10-19)

- [ ] **Register `password_too_short`, `password_too_long`, `delivery_unavailable`,
  `identifier_collision`, `no_email_to_resend` and `invalid_username` in a LATER release, not R7+R9.**
  The owner ruled (2026-10-19) that they stay unregistered this release and are registered later as a
  BREAKING change: each moves off `details.server_code` (SPEC §3.1), so it needs a `### Breaking`
  changelog line in go, ts and java and a partner notice. In the same change: rewrite the SPEC §3.1
  "deliberately NOT registered" notes, the tests that pin `delivery_unavailable` as unregistered
  (go `messaging_test.go`, java `MessagingClientTest`, ts `messaging.test.ts`, `auth-sendlogin.test.ts`),
  keep `IsDeliveryUnavailable` reading both `.code` and `server_code`, then re-vendor the issuer's
  docclaims so `no_email_to_resend` leaves `internal/docclaims/undocumented_error_codes.txt`.

## ADR-056 deferred follow-ups

- [ ] **SDK distributed `WithLock` (Q2).** `go/token_manager.go:32` uses an
  in-process `sync.Mutex`; the BFF's `Store.AcquireRefreshLock`
  (`api/internal/session/store.go:286`, Redis SETNX) stays the authority. Make the
  SDK lock pluggable / BFF-backed.
*(Q4 encrypt-at-rest is done — ADR-060's AES-256-GCM seal in the BFF store. Q5
`X-User-Token` typed-path parity shipped 2026-08-02, ts `0.33.0` + java `0.32.0`
— purged 2026-08-03; the rationale, and the lesson about the wrong grep result
that stood in this file for a week, are in root `DECISIONS.md` and the root
`TODO.md` entry that owns the partner-comms half.)*

