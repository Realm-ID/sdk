package realmid

import (
	ctxpkg "context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// custom_claims_handler.go — the ONLY source of custom claims on a mint the SDK
// runs (SPEC §10.2 SPEC10_2_custom_claims; owner ruling 2026-11-14, audit e-01).
//
// The middleware routes refuse a body carrying custom claims (400
// custom_claims_not_accepted); the claims come from this server-side handler.

// CustomClaimsHandler returns the partner's custom claims for a principal in
// one org: the tenant the mint is for and the user id (`sub`) the session
// resolves to. It is NEVER given request data.
//
// Optional (Config.CustomClaims). Nil or an empty map means no custom claims.
// It runs on EVERY SDK-run mint, refresh included, is not cached, and MUST be
// side-effect free: it is retried and called an unspecified number of times.
type CustomClaimsHandler func(ctx ctxpkg.Context, tenantID, userID string) (map[string]any, error)

// CustomClaimsError reports that YOUR handler failed (or returned a key the
// issuer would refuse) and the SDK therefore refused to mint (SPEC10_2 rules 3
// and 5). Deliberately NOT a *RealmError, for the reason ProductRolesError
// gives: your lookup failing and RealmID refusing a mint are different incidents.
type CustomClaimsError struct {
	TenantID string
	UserID   string
	Attempts int
	Err      error
}

func (e *CustomClaimsError) Error() string {
	return fmt.Sprintf("realmid: customClaims handler failed after %d attempts for tenant %s: %v",
		e.Attempts, e.TenantID, e.Err)
}

func (e *CustomClaimsError) Unwrap() error { return e.Err }

// checkCustomClaimKeys applies SPEC4_2_claim_fold rule 1 to the handler output
// (the one key check, claims.go checkCustomClaimKey).
func checkCustomClaimKeys(m map[string]any) error {
	for k := range m {
		if err := checkCustomClaimKey(k); err != nil {
			return fmt.Errorf("custom claim: %w", err)
		}
	}
	return nil
}

// resolveCustomClaims runs the configured handler with the shared retry policy
// (3 attempts, ~50ms then ~150ms, abandoning on a done context), then checks
// the output keys. Returns (nil, nil) when no handler is configured.
func (r *Realm) resolveCustomClaims(ctx ctxpkg.Context, tenantID, userID string) (map[string]any, error) {
	h := r.cfg.CustomClaims
	if h == nil {
		return nil, nil
	}
	var last error
	for attempt := 0; attempt < productRolesAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, &CustomClaimsError{
					TenantID: tenantID, UserID: userID,
					Attempts: attempt, Err: errors.Join(last, ctx.Err()),
				}
			case <-time.After(productRolesBackoff[attempt-1]):
			}
		}
		claims, err := h(ctx, tenantID, userID)
		if err == nil {
			if kerr := checkCustomClaimKeys(claims); kerr != nil {
				return nil, &CustomClaimsError{TenantID: tenantID, UserID: userID, Attempts: attempt + 1, Err: kerr}
			}
			if len(claims) == 0 {
				return nil, nil
			}
			return claims, nil
		}
		last = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, &CustomClaimsError{
		TenantID: tenantID, UserID: userID,
		Attempts: productRolesAttempts, Err: last,
	}
}

// carrySession wraps err so it carries the session the FIRST mint rotated
// (SPEC4_2_rotate_handover): the rotated refresh token and that mint's access
// token. A mint that rotated nothing carries nothing and err is returned as is.
func carrySession(first *MintResult, err error) error {
	if err == nil || first == nil || first.RefreshToken == "" {
		return err
	}
	return &RefreshHandedOverError{err: err, refreshToken: first.RefreshToken, accessToken: first.AccessToken}
}

// subjectUnreadable is the handler-typed refusal for an SDK-run mint whose
// access token yields no subject (SPEC4_2_rotate_handover decision (c)): the
// handler cannot be asked, and returning the token would silently lack the
// partner's claims.
func subjectUnreadable(tenantID string, cause error) error {
	if cause == nil {
		cause = errors.New("access token carries no readable subject")
	}
	return &CustomClaimsError{TenantID: tenantID, Err: fmt.Errorf("cannot resolve subject: %w", cause)}
}

// fillCustomClaims is SPEC4_2_fill: with a handler configured, a mint whose
// request omitted CustomClaims (nil) is filled from the handler. The first mint
// rotated the refresh token, so any failure from here on carries the rotated
// session (SPEC4_2_rotate_handover). A tokenless rotation, no handler, or an
// empty handler output returns `first` as minted.
func (r *Realm) fillCustomClaims(ctx ctxpkg.Context, first *MintResult, req TokenRequest) (*MintResult, error) {
	if r.cfg.CustomClaims == nil || req.CustomClaims != nil || first == nil || first.RefreshToken == "" {
		return first, nil
	}
	tenantID := req.TenantID
	if first.TenantID != "" {
		tenantID = first.TenantID
	}
	sub, _, _, perr := peekJWTUserFields(first.AccessToken)
	if perr != nil || sub == "" {
		return nil, carrySession(first, subjectUnreadable(tenantID, perr))
	}
	custom, err := r.resolveCustomClaims(ctx, tenantID, sub)
	if err != nil {
		return nil, carrySession(first, err)
	}
	if len(custom) == 0 {
		return first, nil
	}
	req.RefreshToken = first.RefreshToken
	req.CustomClaims = custom
	second, err := r.Auth.token(ctx, req)
	if err != nil {
		return nil, carrySession(first, err)
	}
	return second, nil
}

// bodyCarriesCustomClaims reports whether a request body has either spelling of
// the key, with ANY value (SPEC10_1_4_no_client_claims).
func bodyCarriesCustomClaims(body map[string]any) bool {
	_, a := body["custom_claims"]
	_, b := body["customClaims"]
	return a || b
}

// refuseClientCustomClaims answers 400 custom_claims_not_accepted and reports
// true when the body carries the key (SPEC10_1_4_no_client_claims). Used by the
// login, MFA verify and recovery routes; handleRefresh writes the same shape.
func refuseClientCustomClaims(w http.ResponseWriter, body map[string]any) bool {
	if !bodyCarriesCustomClaims(body) {
		return false
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{
		"code":    "custom_claims_not_accepted",
		"message": "custom claims are set by the server's customClaims handler, not by the client",
	}})
	return true
}
