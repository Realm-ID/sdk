// Package realmid — error taxonomy (SPEC §3).
//
// Every failure surfaced by the SDK is a *RealmError. Callers branch on
// Code (a stable string from the taxonomy in SPEC §3.1) and read
// envelope siblings (e.g. mfa_challenge_token) from Details directly,
// avoiding a second JSON parse.
package realmid

import (
	"context"
	"errors"
	"fmt"
)

// ErrorCode is a stable, machine-readable identifier for an SDK failure.
type ErrorCode string

const (
	// Verifier codes (SPEC §3.1).
	ErrCodeMalformed       ErrorCode = "malformed"
	ErrCodeWrongAlgorithm  ErrorCode = "wrong_algorithm"
	ErrCodeBadSignature    ErrorCode = "bad_signature"
	ErrCodeWrongIssuer     ErrorCode = "wrong_issuer"
	ErrCodeWrongAudience   ErrorCode = "wrong_audience"
	ErrCodeExpired         ErrorCode = "expired"
	ErrCodeNotYetValid     ErrorCode = "not_yet_valid"
	ErrCodeUnknownKID      ErrorCode = "unknown_kid"
	ErrCodeJWKSFetchFailed ErrorCode = "jwks_fetch_failed"

	// Auth-flow codes.
	ErrCodeProviderTokenInvalid ErrorCode = "provider_token_invalid"
	ErrCodeMFARequired          ErrorCode = "mfa_required"
	// ErrCodeMFARegistrationRequired is the first-factor-enrollment variant of
	// the MFA gate: the realm/tenant requires MFA but the user has no confirmed
	// factor yet. The issuer returns it (with mfa_challenge_token + tenant_id)
	// on POST /auth/token; a BFF re-surfaces it so the SPA renders an
	// enrollment screen rather than a code prompt. Must be a *known* code or
	// mapErrorResponse falls back to the generic 412 status code and the gate
	// is lost downstream.
	ErrCodeMFARegistrationRequired ErrorCode = "mfa_registration_required"
	ErrCodeSessionLimitReached     ErrorCode = "session_limit_reached"
	ErrCodeTenantRequired          ErrorCode = "tenant_required"
	ErrCodeTenantInvalid           ErrorCode = "tenant_invalid"
	ErrCodeAccountSuspended        ErrorCode = "account_suspended"
	ErrCodeAccountDeactivated      ErrorCode = "account_deactivated"
	// ErrCodeContactAdminRequired (409) is returned by POST /auth/login when a
	// DIFFERENT provider identity asserts an email/phone already bound to an
	// existing account (ADR-080 Part 2). The issuer refuses to silently link —
	// an owner must first delink the current binding
	// (UsersClient.DelinkContact) before the new provider can bind.
	ErrCodeContactAdminRequired ErrorCode = "contact_admin_required"
	ErrCodeRealmOriginMismatch  ErrorCode = "realm_origin_mismatch"
	// ErrCodeRealmMismatch is the ADR-041 client-side realm pin: the SDK
	// was constructed for realm A but the platform access token's iss
	// references realm B (a confused-deputy guard). Emitted locally by the
	// session manager before any subsequent API call — never a server
	// code on the partner surface (SPEC §3.1).
	ErrCodeRealmMismatch ErrorCode = "realm_mismatch"
	ErrCodeMissingOrigin ErrorCode = "missing_origin"
	// ErrCodeRefreshInvalid is returned by POST /auth/token when the
	// presented refresh token is expired, revoked, or reuse-detected —
	// terminal for the caller (re-authentication required). Distinct from
	// the generic ErrCodeUnauthorized so long-lived clients (TokenManager)
	// can branch on "re-auth required" vs a transient 401. SPEC §3.1.
	ErrCodeRefreshInvalid ErrorCode = "refresh_invalid"

	// Partner OTP primitive (docs/proposals/partner-otp-primitive.md).
	ErrCodeInvalidOTP        ErrorCode = "invalid_otp"
	ErrCodeOTPExpired        ErrorCode = "otp_expired"
	ErrCodeOTPLocked         ErrorCode = "otp_locked"
	ErrCodeOTPNotFound       ErrorCode = "otp_not_found"
	ErrCodeInvalidPurpose    ErrorCode = "invalid_purpose"
	ErrCodeInvalidSubjectRef ErrorCode = "invalid_subject_ref"

	// Cross-realm integrations (ADR-082/083). Registered so the flat error
	// envelope's specific code lands in RealmError.Code (isKnownCode gate),
	// letting the integrations surface map precise sentinels.
	ErrCodeIntegrationSlugTaken      ErrorCode = "slug_taken"
	ErrCodeIntegrationNotFound       ErrorCode = "integration_not_found"
	ErrCodeIntegrationAlreadyInst    ErrorCode = "already_installed"
	ErrCodeIntegrationRoleNotSvc     ErrorCode = "role_not_service_typed"
	ErrCodeIntegrationRoleNotInst    ErrorCode = "role_not_installable"
	ErrCodeInstallationNotFound      ErrorCode = "installation_not_found"
	ErrCodeInstallationRevoked       ErrorCode = "installation_revoked"
	ErrCodeIntegrationRoleUnavail    ErrorCode = "role_unavailable"
	ErrCodeIntegrationKeyClassMisfit ErrorCode = "key_class_mismatch"

	// Management / generic codes.
	ErrCodeUnauthorized ErrorCode = "unauthorized"
	ErrCodeForbidden    ErrorCode = "forbidden"
	ErrCodeNotFound     ErrorCode = "not_found"
	ErrCodeConflict     ErrorCode = "conflict"
	ErrCodeRateLimited  ErrorCode = "rate_limited"
	ErrCodeBadRequest   ErrorCode = "bad_request"
	ErrCodeNetwork      ErrorCode = "network"
	ErrCodeServerError  ErrorCode = "server_error"
)

// RealmError is the unified error returned from every SDK operation.
type RealmError struct {
	Code       ErrorCode
	Message    string
	HTTPStatus int
	Details    map[string]any
	Cause      error
}

// Error implements the error interface.
func (e *RealmError) Error() string {
	if e.HTTPStatus != 0 {
		return fmt.Sprintf("realmid: %s (http %d): %s", e.Code, e.HTTPStatus, e.Message)
	}
	return fmt.Sprintf("realmid: %s: %s", e.Code, e.Message)
}

// Unwrap exposes the underlying cause for errors.Is / errors.As.
func (e *RealmError) Unwrap() error { return e.Cause }

// IsCode reports whether err is a *RealmError with the given Code.
func IsCode(err error, code ErrorCode) bool {
	var re *RealmError
	if errors.As(err, &re) {
		return re.Code == code
	}
	return false
}

// AsRealmError reports whether err (or any error it wraps) is a
// *RealmError, and if so binds it to *target. It mirrors errors.As but
// is provided as a top-level helper so BFF / partner code doesn't need
// to drag errors.As + a local var into every call site.
func AsRealmError(err error, target **RealmError) bool {
	if err == nil || target == nil {
		return false
	}
	return errors.As(err, target)
}

// HTTPStatus returns the HTTP status carried by a *RealmError in err's
// chain, or 0 when err is not a *RealmError (or has no status set).
// Callers can compare to net/http constants to branch on upstream
// status without unwrapping manually.
func HTTPStatus(err error) int {
	var re *RealmError
	if errors.As(err, &re) {
		return re.HTTPStatus
	}
	return 0
}

// IsUnauthorized reports whether err is a *RealmError carrying a 401
// HTTPStatus or the ErrCodeUnauthorized code. Used by BFFs to map an
// issuer revocation to a clean session teardown + 401 to the SPA.
func IsUnauthorized(err error) bool {
	var re *RealmError
	if !errors.As(err, &re) {
		return false
	}
	return re.HTTPStatus == 401 || re.Code == ErrCodeUnauthorized
}

// IsTimeout reports whether err originated from a context cancellation
// or deadline (the request context was cut before the issuer replied),
// regardless of how many layers of *RealmError wrap it. Callers map
// this to a 504 / "upstream timeout" surface so the SPA can distinguish
// "we gave up" from "the issuer said no".
func IsTimeout(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func newErr(code ErrorCode, format string, args ...any) *RealmError {
	return &RealmError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// statusToCode maps an HTTP status to a fallback ErrorCode when the
// server response does not carry an explicit `code` field.
func statusToCode(status int) ErrorCode {
	switch status {
	case 400:
		return ErrCodeBadRequest
	case 401:
		return ErrCodeUnauthorized
	case 403:
		return ErrCodeForbidden
	case 404:
		return ErrCodeNotFound
	case 409:
		return ErrCodeConflict
	case 412:
		return ErrCodeBadRequest // overridden by server `code`
	case 429:
		return ErrCodeRateLimited
	}
	if status >= 500 {
		return ErrCodeServerError
	}
	return ErrCodeBadRequest
}

var knownCodes = map[ErrorCode]struct{}{
	ErrCodeMalformed: {}, ErrCodeWrongAlgorithm: {}, ErrCodeBadSignature: {},
	ErrCodeWrongIssuer: {}, ErrCodeWrongAudience: {}, ErrCodeExpired: {},
	ErrCodeNotYetValid: {}, ErrCodeUnknownKID: {}, ErrCodeJWKSFetchFailed: {},
	ErrCodeProviderTokenInvalid: {}, ErrCodeMFARequired: {},
	ErrCodeMFARegistrationRequired: {},
	ErrCodeSessionLimitReached:     {}, ErrCodeTenantRequired: {},
	ErrCodeTenantInvalid: {}, ErrCodeAccountSuspended: {},
	ErrCodeAccountDeactivated: {}, ErrCodeContactAdminRequired: {},
	ErrCodeRealmOriginMismatch: {},
	ErrCodeRealmMismatch:       {},
	ErrCodeMissingOrigin:       {}, ErrCodeRefreshInvalid: {},
	ErrCodeUnauthorized: {}, ErrCodeForbidden: {},
	ErrCodeNotFound: {}, ErrCodeConflict: {}, ErrCodeRateLimited: {},
	ErrCodeBadRequest: {}, ErrCodeNetwork: {}, ErrCodeServerError: {},
	ErrCodeInvalidOTP: {}, ErrCodeOTPExpired: {}, ErrCodeOTPLocked: {},
	ErrCodeOTPNotFound: {}, ErrCodeInvalidPurpose: {}, ErrCodeInvalidSubjectRef: {},
	ErrCodeIntegrationSlugTaken: {}, ErrCodeIntegrationNotFound: {},
	ErrCodeIntegrationAlreadyInst: {}, ErrCodeIntegrationRoleNotSvc: {},
	ErrCodeIntegrationRoleNotInst: {}, ErrCodeInstallationNotFound: {},
	ErrCodeInstallationRevoked: {}, ErrCodeIntegrationRoleUnavail: {},
	ErrCodeIntegrationKeyClassMisfit: {},
}

func isKnownCode(s string) bool {
	_, ok := knownCodes[ErrorCode(s)]
	return ok
}
