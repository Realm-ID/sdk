package realmid

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

// The consequence of registering a code, not its presence in a list: a
// membership assertion is satisfied by a list nothing reads. What matters is
// that the server's specific code survives into RealmError.Code instead of
// collapsing into the HTTP-status fallback.
func TestRegisteredCodesSurviveMapping(t *testing.T) {
	cases := []struct {
		name   string
		status int
		code   string
		want   ErrorCode
	}{
		// Registered 2026-08-24. Before this, a Go caller could not tell "no
		// such platform" from any other 404 on the request.
		{"platform_not_found", 404, "platform_not_found", ErrCodePlatformNotFound},
		// The six ADR-071/072 codes ts and Java had carried for releases and
		// Go had not — every one of them normalized for Go callers alone.
		{"service_account_not_found", 404, "service_account_not_found", ErrCodeServiceAccountNotFound},
		{"source_not_found", 404, "source_not_found", ErrCodeSourceNotFound},
		{"user_not_found", 404, "user_not_found", ErrCodeUserNotFound},
		{"handle_taken", 409, "handle_taken", ErrCodeHandleTaken},
		{"invalid_role", 400, "invalid_role", ErrCodeInvalidRole},
		{"method_violates_kind", 400, "method_violates_kind", ErrCodeMethodViolatesKind},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !isKnownCode(c.code) {
				t.Fatalf("%s is not a known code, so mapErrorResponse would fall back to the status", c.code)
			}
			if ErrorCode(c.code) != c.want {
				t.Fatalf("const mismatch: %q != %q", c.code, c.want)
			}
		})
	}

	// The control. Without it every assertion above is satisfied by an
	// isKnownCode that returns true for everything, which would make the
	// registration they exist to check irrelevant.
	if isKnownCode("definitely_not_a_registered_code") {
		t.Fatal("isKnownCode accepted an unregistered code — the taxonomy gate is inert")
	}
}

// Go keeps TWO hand-maintained lists in one file: the const block and the
// knownCodes map. A const absent from the map is registered in name only —
// it compiles, it reads as registered, and isKnownCode rejects it. This is the
// in-language half of scripts/taxonomy-parity.py, which cannot run in `go test`.
func TestEveryDeclaredCodeIsKnown(t *testing.T) {
	declared := []ErrorCode{
		ErrCodeMalformed, ErrCodeWrongAlgorithm, ErrCodeBadSignature,
		ErrCodeWrongIssuer, ErrCodeWrongAudience, ErrCodeExpired,
		ErrCodeNotYetValid, ErrCodeUnknownKID, ErrCodeJWKSFetchFailed,
		ErrCodeProviderTokenInvalid, ErrCodeMFARequired, ErrCodeMFARegistrationRequired,
		ErrCodeSessionLimitReached, ErrCodeTenantRequired, ErrCodeTenantInvalid,
		ErrCodeAccountSuspended, ErrCodeAccountDeactivated, ErrCodeContactAdminRequired,
		ErrCodeRealmOriginMismatch, ErrCodeRealmMismatch, ErrCodeMissingOrigin,
		ErrCodeRefreshInvalid,
		ErrCodeInvalidOTP, ErrCodeOTPExpired, ErrCodeOTPLocked, ErrCodeOTPNotFound,
		ErrCodeInvalidPurpose, ErrCodeInvalidSubjectRef,
		ErrCodeHandleTaken, ErrCodeInvalidRole, ErrCodeMethodViolatesKind,
		ErrCodeServiceAccountNotFound, ErrCodeSourceNotFound, ErrCodeUserNotFound,
		ErrCodePlatformNotFound,
		ErrCodeIntegrationSlugTaken, ErrCodeIntegrationNotFound,
		ErrCodeIntegrationAlreadyInst, ErrCodeIntegrationRoleNotSvc,
		ErrCodeIntegrationRoleNotInst, ErrCodeInstallationNotFound,
		ErrCodeInstallationRevoked, ErrCodeIntegrationRoleUnavail,
		ErrCodeIntegrationKeyClassMisfit,
		ErrCodePermissionsRequired, ErrCodeUnknownPermission,
		ErrCodePermissionsExceedGrantor, ErrCodeInstallGrantsNothing,
		// Pagination input validation.
		ErrCodeInvalidCursor, ErrCodeInvalidLimit,
		ErrCodeOwnerCannotBeRevoked, ErrCodeSingleTenantNotReqd,
		ErrCodeNotInvited, ErrCodeNotPending, ErrCodeInvitationsUnavailable,
		ErrCodeOwnerCannotLeave, ErrCodeAlreadyLeft,
		ErrCodeUnauthorized, ErrCodeForbidden, ErrCodeNotFound, ErrCodeConflict,
		ErrCodeRateLimited, ErrCodeBadRequest, ErrCodeNetwork, ErrCodeServerError,
		// ADR-097.
		ErrCodeInvalidScope, ErrCodeTooManyScopes, ErrCodeScopeTooLong,
		ErrCodeScopeNotSupported, ErrCodeReservedClaimKey,
		ErrCodeRealmIDAudienceImmutable, ErrCodeInvalidRename,
	}
	// This list is hand-written and so could itself rot — but it can only rot
	// SHORT, and a short list is caught here: taxonomy-parity.py reads the
	// const block out of the source and would disagree with the count.
	if len(declared) != len(knownCodes) {
		t.Fatalf("this test names %d codes but knownCodes holds %d — one of the two lists moved; "+
			"run scripts/taxonomy-parity.py, which reads the const block from source",
			len(declared), len(knownCodes))
	}
	for _, c := range declared {
		if !isKnownCode(string(c)) {
			t.Errorf("%q is declared but not in knownCodes — registered in name only", c)
		}
	}
}

// TestSentinelsSurviveRegistration is the regression guard for the defect that
// registering a code CAUSED. A sentinel mapper reading only the envelope
// siblings stops matching the moment its code becomes canonical, because a
// registered code lands in RealmError.Code and is never copied into the
// siblings. Nothing fails loudly: the call just returns a bare *RealmError and
// `errors.Is(err, ErrSourceNotFound)` quietly goes false at every call site.
//
// Each case is driven through the NESTED envelope shape the issuer actually
// emits, so it exercises mapErrorResponse rather than a hand-built RealmError.
func TestSentinelsSurviveRegistration(t *testing.T) {
	cases := []struct {
		name   string
		status int
		code   string
		want   error
		call   func(r *Realm) error
	}{
		{"handle_taken", 409, "handle_taken", ErrServiceAccountHandleTaken,
			func(r *Realm) error {
				_, err := r.ServiceAccounts.Create(context.Background(), "t1", ServiceAccountCreate{Handle: "x@y.z"})
				return err
			}},
		{"service_account_not_found", 404, "service_account_not_found", ErrServiceAccountNotFound,
			func(r *Realm) error {
				_, err := r.ServiceAccounts.Create(context.Background(), "t1", ServiceAccountCreate{Handle: "x@y.z"})
				return err
			}},
		{"invalid_role", 400, "invalid_role", ErrServiceAccountInvalidRole,
			func(r *Realm) error {
				_, err := r.ServiceAccounts.Create(context.Background(), "t1", ServiceAccountCreate{Handle: "x@y.z"})
				return err
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Precondition: the code really is registered. Without it this
			// test would pass just as well in the pre-registration world,
			// where the sibling path carried everything — and would therefore
			// not be measuring the hazard it is named for.
			if !isKnownCode(c.code) {
				t.Fatalf("%s is not registered; this test measures the REGISTERED case", c.code)
			}
			srv := authTestServer(t, map[string]http.HandlerFunc{
				"/tenants/t1/service-accounts": func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(c.status)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": map[string]any{"code": c.code, "message": "x"},
					})
				},
			})
			defer srv.Close()
			r, _ := NewRealm(Config{RealmID: testRealmID, APIKey: "rk", BaseURL: srv.URL})
			if err := c.call(r); !errors.Is(err, c.want) {
				t.Fatalf("want sentinel %v, got %v", c.want, err)
			}
		})
	}
}
