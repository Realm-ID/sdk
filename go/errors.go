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
	"time"
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
	// ErrCodeTokenStale (401, ADR-107 D10) is emitted by the VERIFIER, not the
	// issuer: the presented access token was minted before the subject's
	// authority changed, so its `role`/`scope`/`product_roles` no longer
	// describe them. The remedy is a single refresh, and the client SDK
	// performs it transparently.
	//
	// Distinct from `unauthorized` and `refresh_invalid` for the reason
	// `refresh_invalid` itself exists: a client that collapses every 401 into
	// "sign the user out" would sign people out on PROMOTION — on a grant that
	// just widened their access. Branch on this code BEFORE IsUnauthorized,
	// which is also true of it (it is a 401).
	ErrCodeTokenStale ErrorCode = "token_stale"
	// ErrCodeUserSuspended (403, issuer ADR-104 R-d): the token's subject row in
	// THAT org is suspended or deactivated. Not a sign-out: a session spans orgs,
	// and the person may still be active in another. The BFF middleware relays it
	// as 403 and never tears the session down.
	ErrCodeUserSuspended ErrorCode = "user_suspended"
	// ErrCodeTenantDisabled (403, issuer spec 0.59.0): the org the token is for
	// is suspended or deactivated. Not a sign-out: the session is NOT ended and
	// the person may still use their other orgs. The BFF middleware relays it as
	// 403 and never tears the session down.
	ErrCodeTenantDisabled ErrorCode = "tenant_disabled"
	// ErrCodeEscortSuspended (403 from the issuer, ADR-104 R-d): the BFF's own
	// /auth/* escort account is suspended or deactivated. A service problem, not
	// the user's; the BFF middleware relays it as 503, session untouched.
	ErrCodeEscortSuspended ErrorCode = "escort_suspended"
	// ErrCodeLastOwner (409) is returned by BOTH owner-protection paths on the
	// issuer: changing the owner's role, and DEACTIVATING the owner. The remedy
	// is to transfer ownership first (ADR-076).
	//
	// Registered 2026-09-04 after a partner reported that their error mapper
	// "had no last_owner case" — because the SDK never gave them one. Two doc
	// comments promised the code BY NAME while no taxonomy declared it, so
	// mapErrorResponse fell back to the status and every caller in every
	// language received a generic `conflict`. A doc comment describing a code
	// the SDK then flattens is worse than silence: a partner writes the branch,
	// tests it against a mock, and it never fires in production.
	//
	// ⚠️ Only `deactivated` is guarded. SUSPENDING the sole owner succeeds by
	// design — suspension is reversible and needs no ownership handover — so a
	// tenant CAN be left with a suspended owner and no administrator.
	ErrCodeLastOwner ErrorCode = "last_owner"

	// ADR-097 — the `scope` intake on POST /auth/token (SPEC §11).
	//
	// These are the issuer's REFUSALS. `insufficient_scope`, the 403 an SDK
	// route gate emits, is deliberately NOT here: no issuer handler produces
	// it, and a taxonomy entry with no producer is the `not_service` phantom
	// this taxonomy already carries one of.
	//
	// ErrCodeInvalidScope: a `scope` entry is not an RFC 6749 §3.3
	// scope-token. Refused rather than reshaped — a SPACE inside a value would
	// split one scope into two, silently changing the authority granted.
	ErrCodeInvalidScope ErrorCode = "invalid_scope"
	// ErrCodeTooManyScopes / ErrCodeScopeTooLong: `scope` exceeds the realm's
	// user_api_keys.max_permission_strings / max_permission_string_len. The
	// claim rides an Authorization header against ~8KB server limits, so the
	// issuer refuses at mint rather than handing back a token that dies at the
	// next hop with an opaque proxy error.
	ErrCodeTooManyScopes ErrorCode = "too_many_scopes"
	ErrCodeScopeTooLong  ErrorCode = "scope_too_long"
	// ErrCodeScopeNotSupported: this session class mints no `scope` claim (a
	// service-class refresh). Refused rather than ignored — a field that is
	// sendable and enforced nowhere reads as working, and a partner would ship
	// a gate against a claim that never arrives.
	ErrCodeScopeNotSupported ErrorCode = "scope_not_supported"
	// ErrCodeReservedClaimKey: a `custom_claims` key collides with a reserved
	// JWT claim name. Previously dropped silently; from ADR-097 D3 it is
	// refused, because a dropped claim is indistinguishable from an honoured
	// one on the caller's side.
	ErrCodeReservedClaimKey ErrorCode = "reserved_claim_key"
	// ErrCodeRealmIDAudienceImmutable: POST /platforms/{id}/scopes/rename on a
	// `realmid`-audience realm. Its permission vocabulary is RealmID's OWN
	// ADR-074 catalog, validated at mint, so a rename could write a string past
	// that gate and the cap would quietly stop matching anything.
	ErrCodeRealmIDAudienceImmutable ErrorCode = "realmid_audience_immutable"
	// ErrCodeInvalidRename: `to` equals `from`, on either the role rename or
	// the ADR-097 scope rename.
	ErrCodeInvalidRename ErrorCode = "invalid_rename"

	// Partner OTP primitive (docs/proposals/partner-otp-primitive.md).
	ErrCodeInvalidOTP        ErrorCode = "invalid_otp"
	ErrCodeOTPExpired        ErrorCode = "otp_expired"
	ErrCodeOTPLocked         ErrorCode = "otp_locked"
	ErrCodeOTPNotFound       ErrorCode = "otp_not_found"
	ErrCodeInvalidPurpose    ErrorCode = "invalid_purpose"
	ErrCodeInvalidSubjectRef ErrorCode = "invalid_subject_ref"

	// Service accounts (ADR-071) + sources (ADR-072). ts and Java have carried
	// these since those releases; Go did not, so every one of them collapsed
	// into the generic status code for Go callers alone. Found 2026-08-24 while
	// adding ErrCodePlatformNotFound — the taxonomy was recorded as "consistent
	// across the three SDKs" and was eight codes out of sync.
	//
	// NOT added: `not_service`, which ts and Java declare and the issuer emits
	// NOWHERE (its only near-match is the distinct `role_not_service_typed`).
	// A code with no producer is a phantom; propagating it would spread one.
	// See scripts/taxonomy-parity.sh, which carries it as a reviewed exception.
	ErrCodeHandleTaken            ErrorCode = "handle_taken"
	ErrCodeInvalidRole            ErrorCode = "invalid_role"
	ErrCodeMethodViolatesKind     ErrorCode = "method_violates_kind"
	ErrCodeServiceAccountNotFound ErrorCode = "service_account_not_found"
	ErrCodeSourceNotFound         ErrorCode = "source_not_found"
	ErrCodeUserNotFound           ErrorCode = "user_not_found"

	// ErrCodePlatformNotFound is what the issuer answers on every by-id
	// platform route (16 call sites). Registered for the same reason as the
	// six sibling *_not_found codes: without it the code falls back to
	// statusToCode(404) and the caller cannot tell "no such platform" from
	// any other 404 on the request. It never distinguishes "not yours" from
	// "never existed" — the issuer answers both identically on purpose
	// (v0.78.0 oracle rule), which is a security property, not a taxonomy one.
	ErrCodePlatformNotFound ErrorCode = "platform_not_found"

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

	// ADR-101 D7 replaced the install's role with a stated permission list.
	// Registered for the same reason as the block above: unregistered, the
	// specific code reaches RealmError.Code only via the envelope siblings, so a
	// Go caller reading re.Code sees `bad_request`/`forbidden` while ts and Java
	// see the precise string — a cross-language divergence in the one field
	// callers branch on. The sentinels in integrations.go match either way
	// (specificCode reads both levels); this is about Code fidelity.
	ErrCodePermissionsRequired      ErrorCode = "permissions_required"
	ErrCodeUnknownPermission        ErrorCode = "unknown_permission"
	ErrCodePermissionsExceedGrantor ErrorCode = "permissions_exceed_grantor"
	ErrCodeInstallGrantsNothing     ErrorCode = "install_grants_nothing"

	// Pagination input validation (issuer, 2026-09-03). Both 400, and
	// deliberately TWO codes rather than one because the caller's correction
	// differs: invalid_cursor means RESTART THE WALK (the cursor is
	// non-numeric, signed, or past the max offset), invalid_limit means FIX
	// YOUR CONSTANT (non-numeric or <= 0).
	//
	// Neither fires on the ordinary cases: a well-formed cursor past the end
	// still returns an empty last page (rows can be deleted mid-walk), and a
	// limit ABOVE the maximum still CLAMPS rather than rejecting. So an
	// invalid_cursor a caller did not construct by hand is a bug in the
	// caller's cursor handling, not a race.
	//
	// Registered here for the reason the ADR-101 block above records: an
	// unregistered code reaches RealmError.Code only via the envelope siblings,
	// so a Go caller reading re.Code would see a bare `bad_request` while ts
	// and Java see the precise string. go/v0.52.0 shipped four codes missing
	// from this taxonomy and callers could not branch on them.
	ErrCodeInvalidCursor ErrorCode = "invalid_cursor"
	ErrCodeInvalidLimit  ErrorCode = "invalid_limit"

	// Membership self-service (ADR-092 D5). Registered so the flat envelope's
	// specific code reaches RealmError.Code instead of collapsing into the
	// generic 409 `conflict` — every one of these has a distinct remedy the
	// caller must render, and they are indistinguishable by status alone.
	//
	// ErrCodeOwnerCannotBeRevoked / ErrCodeOwnerCannotLeave are the SAME rule
	// (`tenants.owner_user_id` is NOT NULL) on two routes; both are answered by
	// transferring ownership (ADR-076) first, not by retrying.
	//
	// ErrCodeMembershipNotFound (404) is the self-service routes' refusal when
	// the caller has no reachable membership in the named org — three sites in
	// the issuer's me_memberships.go. It NEVER distinguishes "not yours" from
	// "never existed"; both answer identically on purpose, the same oracle rule
	// ErrCodePlatformNotFound carries. Registered because MembershipActionCode
	// in the ts SDK already listed it by name while no taxonomy declared it, so
	// the code a caller was told to branch on arrived as a generic not_found.
	ErrCodeOwnerCannotBeRevoked   ErrorCode = "owner_cannot_be_revoked"
	ErrCodeMembershipNotFound     ErrorCode = "membership_not_found"
	ErrCodeSingleTenantNotReqd    ErrorCode = "single_tenant_not_required"
	ErrCodeNotInvited             ErrorCode = "not_invited"
	ErrCodeNotPending             ErrorCode = "not_pending"
	ErrCodeInvitationsUnavailable ErrorCode = "invitations_unavailable"
	ErrCodeOwnerCannotLeave       ErrorCode = "owner_cannot_leave"
	ErrCodeAlreadyLeft            ErrorCode = "already_left"

	// ADR-117 (platform-declared unique contact kinds) and ADR-116 third
	// amendment (contact proof), issuer spec 0.62.0; SPEC §3.1. The 409s on the
	// config PATCH each carry a body naming the offender (unique_kind_lockout:
	// {kind, locked_out, mfa_locked_out}; unique_kind_duplicates: {kind,
	// conflicting_values}; email_keyed_signin_enabled: {identity_providers,
	// sso_domains}), which arrives in RealmError.Details. In
	// unique_kind_lockout_check_failed a count of -1 means "could not count",
	// never "none", and ?confirm_lockout=true never escapes it.
	// invalid_config_value and identifier_collision already existed on the
	// wire and are deliberately NOT registered here (no behaviour change for
	// callers reading Details["server_code"]).
	ErrCodeUniqueKindsRequiresPassword  ErrorCode = "unique_kinds_requires_password"
	ErrCodePasswordLoginRequired        ErrorCode = "password_login_required"
	ErrCodeUniqueKindLockout            ErrorCode = "unique_kind_lockout"
	ErrCodeUniqueKindLockoutCheckFailed ErrorCode = "unique_kind_lockout_check_failed"
	ErrCodeUniqueKindDuplicates         ErrorCode = "unique_kind_duplicates"
	ErrCodeEmailKeyedSigninEnabled      ErrorCode = "email_keyed_signin_enabled"
	ErrCodeRequireVerifiedEmailConflict ErrorCode = "require_verified_email_conflict"
	ErrCodeIdPRequiresIdentifyingEmail  ErrorCode = "idp_requires_identifying_email"
	ErrCodeIdPRequiresIdentifyingPhone  ErrorCode = "idp_requires_identifying_phone"
	ErrCodeDomainSSORequiresUniqueEmail ErrorCode = "domain_sso_requires_unique_email"
	ErrCodeInviteContactNotIdentifying  ErrorCode = "invite_contact_not_identifying"
	ErrCodeRecipientEmailNotIdentifying ErrorCode = "recipient_email_not_identifying"
	ErrCodeInvalidInvitationToken       ErrorCode = "invalid_invitation_token"
	ErrCodeContactNotFound              ErrorCode = "contact_not_found"
	ErrCodeContactAlreadyVerified       ErrorCode = "contact_already_verified"
	ErrCodeContactChanged               ErrorCode = "contact_changed"
	ErrCodeResetEmailNotIdentifying     ErrorCode = "reset_email_not_identifying"

	// Password-credential codes (SPEC §3.1; ADR-104 amendment + ADR-111, issuer
	// spec 0.53.0). password_must_change / password_too_short / password_too_long
	// are deliberately NOT registered: they predate this and arrive as
	// Details["server_code"].
	ErrCodePasswordUnchanged         ErrorCode = "password_unchanged"
	ErrCodePasswordChangeNotRequired ErrorCode = "password_change_not_required"
	ErrCodeResetLinkRequired         ErrorCode = "reset_link_required"
	ErrCodeVerifiedEmailRequired     ErrorCode = "verified_email_required"
	ErrCodeNoVerifiedEmail           ErrorCode = "no_verified_email"
	ErrCodeResetThrottled            ErrorCode = "reset_throttled"
	ErrCodeResetTokenInvalid         ErrorCode = "reset_token_invalid"
	ErrCodeResetTokenExpired         ErrorCode = "reset_token_expired"
	ErrCodeResetTokenUsed            ErrorCode = "reset_token_used"
	ErrCodeResetTokenSuperseded      ErrorCode = "reset_token_superseded"

	// Phone-delivery channel codes (SPEC §3.1; ADR-115, issuer spec 0.60.0), all
	// new to the wire in that spec. delivery_unavailable is deliberately NOT
	// registered: it has shipped since ADR-103 and reaches callers as
	// Details["server_code"], so registering it would move it. Its new `channel`
	// field lands in Details["channel"].
	ErrCodeInvalidChannelConfig    ErrorCode = "invalid_channel_config"
	ErrCodeChannelValidationFailed ErrorCode = "channel_validation_failed"
	ErrCodeChannelNotConfigured    ErrorCode = "channel_not_configured"
	ErrCodePhoneOTPRateLimited     ErrorCode = "phone_otp_rate_limited"

	// Sign-in code send codes (SPEC §3.1; ADR-116, issuer spec 0.61.0).
	// sign_in_ip_rate_limited and invalid_on_behalf_of_ip are new to the wire.
	// method_not_enabled is registered although it already ships (400 on the
	// ADR-094 domain-SSO routes, where it used to arrive as
	// Details["server_code"]): a BEHAVIOUR CHANGE, owner ruling 2026-10-18.
	// delivery_unavailable stays unregistered; see IsDeliveryUnavailable.
	ErrCodeSignInIPRateLimited ErrorCode = "sign_in_ip_rate_limited"
	ErrCodeMethodNotEnabled    ErrorCode = "method_not_enabled"
	ErrCodeInvalidOnBehalfOfIP ErrorCode = "invalid_on_behalf_of_ip"

	// Workload-login replay (SPEC §3.1/§4.0.1, 2026-10-26): 409 on a token-exchange
	// login whose assertion the issuer has already seen. Transient; the session
	// manager retries it with a freshly fetched credential.
	ErrCodeAssertionReplayed ErrorCode = "assertion_replayed"

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
//
// RetryAfter is the server's Retry-After on a non-2xx response (SPEC §3): a
// delta-seconds value, or an HTTP-date taken as the wait from now. Zero means
// the header was absent, unparseable, negative, or already in the past. No other
// response header is carried.
type RealmError struct {
	Code       ErrorCode
	Message    string
	HTTPStatus int
	Details    map[string]any
	Cause      error
	RetryAfter time.Duration
}

// ErrActorRequired is the R86 sentinel for `403 actor_required`: the call needs a carried user
// or service account. It rides in RealmError.Cause for BOTH the SDK's own local refusal and the
// error the response decoder builds for the server's code, so `errors.Is(err, ErrActorRequired)`
// and IsActorRequired cannot tell them apart (SPEC §3.1 naming, §14.10).
var ErrActorRequired = errors.New("realmid: this action needs a user or service account")

// ErrCodeActorRequired is the wire code of `403 actor_required` (R60, R61, R86).
const ErrCodeActorRequired ErrorCode = "actor_required"

// ErrCodeUnpinnedKID refuses a token whose kid the split bundle does not pin (SPEC §14.4).
const ErrCodeUnpinnedKID ErrorCode = "unpinned_kid"

// actorRequiredHint is the text partners read when a job forgets the actor (SPEC §14.10).
const actorRequiredHint = "This action needs a user or service account. Send its token in X-User-Token."

// newActorRequired builds the typed error for a local refusal: nothing was sent.
func newActorRequired() *RealmError {
	return &RealmError{Code: ErrCodeActorRequired, Message: actorRequiredHint, Cause: ErrActorRequired}
}

// IsActorRequired reports whether err is, or wraps, the R86 actor-required error: the SDK's
// local refusal or the server's `403 actor_required`. Safe on nil.
func IsActorRequired(err error) bool {
	return err != nil && errors.Is(err, ErrActorRequired)
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

// IsTokenStale reports whether err is the ADR-107 staleness refusal: the token
// was minted before its subject's authority changed. The caller's move is ONE
// refresh + replay — and, if the replay fails the same way on a token minted
// after that refresh, a hard failure rather than a second refresh (D13).
//
// Check this BEFORE IsUnauthorized. token_stale carries a 401, so
// IsUnauthorized is true of it too, and a caller that tests the general
// predicate first will tear down a session that only needed a refresh.
func IsTokenStale(err error) bool {
	var re *RealmError
	if !errors.As(err, &re) {
		return false
	}
	return re.Code == ErrCodeTokenStale
}

// IsUserSuspended reports whether err is the issuer's 403 user_suspended: the
// subject's row in this org is suspended or deactivated (ADR-104 R-d). Do not
// sign the user out of their other orgs.
func IsUserSuspended(err error) bool {
	var re *RealmError
	if !errors.As(err, &re) {
		return false
	}
	return re.Code == ErrCodeUserSuspended
}

// IsTenantDisabled reports whether err is the issuer's 403 tenant_disabled: the
// org the token is for is suspended or deactivated. The session is not ended;
// do not sign the user out of their other orgs.
func IsTenantDisabled(err error) bool {
	var re *RealmError
	if !errors.As(err, &re) {
		return false
	}
	return re.Code == ErrCodeTenantDisabled
}

// IsInvalidChannelConfig reports whether err is the issuer's 400
// invalid_channel_config: a messaging save broke a shape rule; the message names
// the field (SPEC §6.16).
func IsInvalidChannelConfig(err error) bool { return IsCode(err, ErrCodeInvalidChannelConfig) }

// IsChannelValidationFailed reports whether err is the issuer's 422
// channel_validation_failed: the provider refused the credentials; the message is
// the provider's reason. Nothing was stored.
func IsChannelValidationFailed(err error) bool {
	return IsCode(err, ErrCodeChannelValidationFailed)
}

// IsChannelNotConfigured reports whether err is the issuer's 404
// channel_not_configured: the realm has saved nothing for that channel.
func IsChannelNotConfigured(err error) bool { return IsCode(err, ErrCodeChannelNotConfigured) }

// IsPhoneOTPRateLimited reports whether err is the issuer's 429
// phone_otp_rate_limited: this number was sent the realm's limit of phone codes
// within the window. The wait is RealmError.RetryAfter.
func IsPhoneOTPRateLimited(err error) bool { return IsCode(err, ErrCodePhoneOTPRateLimited) }

// IsSignInIPRateLimited reports whether err is the issuer's 429
// sign_in_ip_rate_limited: this end user's IP (the OnBehalfOfIP passed to
// SendLoginCode) has used the realm's phone_otp.sign_in_per_ip_per_hour.
func IsSignInIPRateLimited(err error) bool { return IsCode(err, ErrCodeSignInIPRateLimited) }

// IsDeliveryUnavailable reports whether err is the issuer's 503
// delivery_unavailable: the realm has no working channel for the requested
// delivery mode (Details["channel"] names it). The code is NOT registered (it
// shipped before the taxonomy named it), so it arrives as
// Details["server_code"]; this checks both places and keeps working if the code
// is registered later.
func IsDeliveryUnavailable(err error) bool {
	var re *RealmError
	if !errors.As(err, &re) {
		return false
	}
	return string(re.Code) == "delivery_unavailable" || detailCode(re) == "delivery_unavailable"
}

// IsEscortSuspended reports whether err is the issuer's 403 escort_suspended:
// the BFF's own escort account is disabled (ADR-104 R-d). A service problem.
func IsEscortSuspended(err error) bool {
	var re *RealmError
	if !errors.As(err, &re) {
		return false
	}
	return re.Code == ErrCodeEscortSuspended
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
	ErrCodeTokenStale: {}, ErrCodeLastOwner: {},
	ErrCodeUserSuspended: {}, ErrCodeEscortSuspended: {}, ErrCodeTenantDisabled: {},
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
	ErrCodePermissionsRequired:       {}, ErrCodeUnknownPermission: {},
	ErrCodePermissionsExceedGrantor: {}, ErrCodeInstallGrantsNothing: {},
	ErrCodeInvalidCursor: {}, ErrCodeInvalidLimit: {},
	ErrCodeOwnerCannotBeRevoked: {}, ErrCodeMembershipNotFound: {},
	ErrCodeSingleTenantNotReqd: {},
	ErrCodeNotInvited:          {}, ErrCodeNotPending: {},
	ErrCodeInvitationsUnavailable: {}, ErrCodeOwnerCannotLeave: {},
	ErrCodeAlreadyLeft: {},
	ErrCodeHandleTaken: {}, ErrCodeInvalidRole: {},
	ErrCodeMethodViolatesKind: {}, ErrCodeServiceAccountNotFound: {},
	ErrCodeSourceNotFound: {}, ErrCodeUserNotFound: {},
	ErrCodePlatformNotFound: {},
	// ADR-097.
	ErrCodeInvalidScope: {}, ErrCodeTooManyScopes: {}, ErrCodeScopeTooLong: {},
	ErrCodeScopeNotSupported: {}, ErrCodeReservedClaimKey: {},
	ErrCodeRealmIDAudienceImmutable: {}, ErrCodeInvalidRename: {},
	// SPEC §3.1 password-credential codes.
	ErrCodePasswordUnchanged: {}, ErrCodePasswordChangeNotRequired: {},
	ErrCodeResetLinkRequired: {}, ErrCodeVerifiedEmailRequired: {},
	ErrCodeNoVerifiedEmail: {}, ErrCodeResetThrottled: {},
	ErrCodeResetTokenInvalid: {}, ErrCodeResetTokenExpired: {},
	ErrCodeResetTokenUsed: {}, ErrCodeResetTokenSuperseded: {},
	// SPEC §3.1 phone-delivery channel codes (ADR-115).
	ErrCodeInvalidChannelConfig: {}, ErrCodeChannelValidationFailed: {},
	ErrCodeChannelNotConfigured: {}, ErrCodePhoneOTPRateLimited: {},
	// SPEC §3.1 sign-in code send codes (ADR-116).
	ErrCodeSignInIPRateLimited: {}, ErrCodeMethodNotEnabled: {}, ErrCodeInvalidOnBehalfOfIP: {},
	// SPEC §3.1 unique-contact-kind and contact-proof codes (ADR-117, ADR-116 A3).
	ErrCodeUniqueKindsRequiresPassword: {}, ErrCodePasswordLoginRequired: {},
	ErrCodeUniqueKindLockout: {}, ErrCodeUniqueKindLockoutCheckFailed: {},
	ErrCodeUniqueKindDuplicates: {}, ErrCodeEmailKeyedSigninEnabled: {},
	ErrCodeRequireVerifiedEmailConflict: {}, ErrCodeIdPRequiresIdentifyingEmail: {},
	ErrCodeIdPRequiresIdentifyingPhone: {}, ErrCodeDomainSSORequiresUniqueEmail: {},
	ErrCodeInviteContactNotIdentifying: {}, ErrCodeRecipientEmailNotIdentifying: {},
	ErrCodeInvalidInvitationToken: {}, ErrCodeContactNotFound: {},
	ErrCodeContactAlreadyVerified: {}, ErrCodeContactChanged: {},
	ErrCodeResetEmailNotIdentifying: {}, ErrCodeAssertionReplayed: {},
	// SPEC §14.4, §14.10 (split signing; R60, R86).
	ErrCodeActorRequired: {}, ErrCodeUnpinnedKID: {},
}

func isKnownCode(s string) bool {
	_, ok := knownCodes[ErrorCode(s)]
	return ok
}
