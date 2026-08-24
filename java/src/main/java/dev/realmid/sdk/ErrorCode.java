package dev.realmid.sdk;

/**
 * Stable, machine-readable identifier for any SDK failure. Mirrors the
 * ErrorCode union in the TypeScript SDK and the constants in the Go SDK
 * (SPEC §3.1).
 */
public enum ErrorCode {
    // verifier
    MALFORMED("malformed"),
    WRONG_ALGORITHM("wrong_algorithm"),
    BAD_SIGNATURE("bad_signature"),
    WRONG_ISSUER("wrong_issuer"),
    WRONG_AUDIENCE("wrong_audience"),
    EXPIRED("expired"),
    NOT_YET_VALID("not_yet_valid"),
    UNKNOWN_KID("unknown_kid"),
    JWKS_FETCH_FAILED("jwks_fetch_failed"),

    // auth-flow
    PROVIDER_TOKEN_INVALID("provider_token_invalid"),
    MFA_REQUIRED("mfa_required"),
    /**
     * The first-factor-ENROLLMENT variant of the MFA gate (412): the realm or
     * tenant requires MFA and the user has no confirmed factor yet, so the
     * remedy is an enrollment screen rather than a code prompt. Go has carried
     * this since ADR-061; Java did not, so it collapsed into the generic 412
     * mapping for exactly the clients that must render a different screen.
     */
    MFA_REGISTRATION_REQUIRED("mfa_registration_required"),
    SESSION_LIMIT_REACHED("session_limit_reached"),
    TENANT_REQUIRED("tenant_required"),
    TENANT_INVALID("tenant_invalid"),
    ACCOUNT_SUSPENDED("account_suspended"),
    ACCOUNT_DEACTIVATED("account_deactivated"),
    /**
     * Returned (409) by {@code POST /auth/login} when a different provider
     * identity attempts to claim a contact (email/phone) already bound to
     * another user — the ADR-080 Phase B new-provider approval gate. The login
     * fails <em>closed</em>; an owner/admin must explicitly delink the contact
     * ({@code UsersClient.delinkContact}) or hand the account back
     * ({@code UsersClient.handBack}) before the new identity can bind. The
     * user-facing message is "managed by your org — contact an admin".
     */
    CONTACT_ADMIN_REQUIRED("contact_admin_required"),
    REALM_ORIGIN_MISMATCH("realm_origin_mismatch"),
    /**
     * ADR-041 client-side realm pin: the SDK was constructed for realm A
     * but the platform access token's {@code iss} references realm B (a
     * confused-deputy guard). Emitted locally before any subsequent API
     * call — never a server code on the partner surface (SPEC §3.1). The
     * Java SDK does not yet perform this client-side pin (Go/TS do); the
     * constant is present for cross-language taxonomy parity.
     */
    REALM_MISMATCH("realm_mismatch"),
    MISSING_ORIGIN("missing_origin"),

    /**
     * ADR-097 — a {@code scope} entry on {@code POST /auth/token} is not an RFC
     * 6749 §3.3 scope-token. Refused rather than reshaped: a SPACE inside a
     * value would split one scope into two, silently changing the authority
     * granted.
     *
     * <p>{@code insufficient_scope} — the 403 an SDK route gate emits — is
     * deliberately NOT in this taxonomy: no issuer handler produces it, and a
     * taxonomy entry with no producer is a phantom.
     */
    INVALID_SCOPE("invalid_scope"),
    /**
     * ADR-097 — {@code scope} exceeds the realm's
     * {@code user_api_keys.max_permission_strings}. Refused at mint rather than
     * handed back as a token that dies at the next hop with an opaque proxy
     * error.
     */
    TOO_MANY_SCOPES("too_many_scopes"),
    /** ADR-097 — a {@code scope} entry exceeds {@code max_permission_string_len}. */
    SCOPE_TOO_LONG("scope_too_long"),
    /**
     * ADR-097 — this session class mints no {@code scope} claim (a
     * service-class refresh). Refused rather than ignored: a field that is
     * sendable and enforced nowhere reads as working.
     */
    SCOPE_NOT_SUPPORTED("scope_not_supported"),
    /**
     * ADR-097 D3 — a {@code custom_claims} key collides with a reserved JWT
     * claim name. Previously dropped silently; refused now, because a dropped
     * claim is indistinguishable from an honoured one on the caller's side.
     */
    RESERVED_CLAIM_KEY("reserved_claim_key"),
    /**
     * ADR-097 §F — a scope rename against a {@code realmid}-audience realm,
     * whose permission vocabulary is RealmID's own validated ADR-074 catalog.
     */
    REALMID_AUDIENCE_IMMUTABLE("realmid_audience_immutable"),
    /** {@code to} equals {@code from} on a role or scope rename. */
    INVALID_RENAME("invalid_rename"),
    /**
     * Returned by {@code POST /auth/token} when the presented refresh token is
     * expired, revoked, or reuse-detected — terminal for the caller (no retry
     * will help). Distinct from the generic {@link #UNAUTHORIZED} so long-lived
     * clients (the {@code TokenManager}, SPEC §4.2.1) can deterministically
     * branch on "re-authentication required" versus a transient 401. The SDK
     * does not subdivide expiry/revocation/reuse — all three collapse here, as
     * the issuer does not distinguish them on the wire (SPEC §3.1).
     */
    REFRESH_INVALID("refresh_invalid"),

    // partner OTP primitive (SPEC §X)
    INVALID_OTP("invalid_otp"),
    OTP_EXPIRED("otp_expired"),
    OTP_LOCKED("otp_locked"),
    OTP_NOT_FOUND("otp_not_found"),
    INVALID_PURPOSE("invalid_purpose"),
    INVALID_SUBJECT_REF("invalid_subject_ref"),

    // service accounts (ADR-071) + sources (ADR-072)
    HANDLE_TAKEN("handle_taken"),
    INVALID_ROLE("invalid_role"),
    SERVICE_ACCOUNT_NOT_FOUND("service_account_not_found"),
    NOT_SERVICE("not_service"),
    METHOD_VIOLATES_KIND("method_violates_kind"),
    SOURCE_NOT_FOUND("source_not_found"),
    USER_NOT_FOUND("user_not_found"),

    /**
     * What the issuer answers on every by-id platform route (16 call sites).
     * Registered for the same reason as the six sibling {@code *_not_found}
     * codes: without it the code falls back to the status mapping and the
     * caller cannot tell "no such platform" from any other 404 on the request.
     * It never distinguishes "not yours" from "never existed" — the issuer
     * answers both identically on purpose (issuer v0.78.0 oracle rule), which
     * is a security property rather than a taxonomy one.
     */
    PLATFORM_NOT_FOUND("platform_not_found"),

    // cross-realm integrations (ADR-082/083)
    SLUG_TAKEN("slug_taken"),
    INTEGRATION_NOT_FOUND("integration_not_found"),
    ALREADY_INSTALLED("already_installed"),
    ROLE_NOT_SERVICE_TYPED("role_not_service_typed"),
    ROLE_NOT_INSTALLABLE("role_not_installable"),
    INSTALLATION_NOT_FOUND("installation_not_found"),
    INSTALLATION_REVOKED("installation_revoked"),
    ROLE_UNAVAILABLE("role_unavailable"),
    KEY_CLASS_MISMATCH("key_class_mismatch"),

    // membership self-service (ADR-092 D5). Present so the specific code
    // reaches the caller instead of collapsing into the generic 409
    // {@link #CONFLICT} — each has a distinct remedy and they are
    // indistinguishable by status alone. OWNER_CANNOT_BE_REVOKED and
    // OWNER_CANNOT_LEAVE are the same rule (`tenants.owner_user_id` is NOT
    // NULL) on two routes: both are answered by an ADR-076 ownership transfer,
    // never by a retry.
    OWNER_CANNOT_BE_REVOKED("owner_cannot_be_revoked"),
    SINGLE_TENANT_NOT_REQUIRED("single_tenant_not_required"),
    NOT_INVITED("not_invited"),
    NOT_PENDING("not_pending"),
    INVITATIONS_UNAVAILABLE("invitations_unavailable"),
    OWNER_CANNOT_LEAVE("owner_cannot_leave"),
    ALREADY_LEFT("already_left"),

    // management / generic
    UNAUTHORIZED("unauthorized"),
    FORBIDDEN("forbidden"),
    NOT_FOUND("not_found"),
    CONFLICT("conflict"),
    RATE_LIMITED("rate_limited"),
    BAD_REQUEST("bad_request"),
    NETWORK("network"),
    SERVER_ERROR("server_error");

    private final String wire;

    ErrorCode(String wire) {
        this.wire = wire;
    }

    /** Wire form, matches TS / Go SDK. */
    public String wire() {
        return wire;
    }

    /** Look up an ErrorCode by its wire string, or null if unknown. */
    public static ErrorCode fromWire(String s) {
        if (s == null) return null;
        for (ErrorCode c : values()) {
            if (c.wire.equals(s)) return c;
        }
        return null;
    }

    /** Fallback when the server doesn't carry an explicit code. */
    public static ErrorCode fromHttpStatus(int status) {
        if (status == 400) return BAD_REQUEST;
        if (status == 401) return UNAUTHORIZED;
        if (status == 403) return FORBIDDEN;
        if (status == 404) return NOT_FOUND;
        if (status == 409) return CONFLICT;
        if (status == 412) return BAD_REQUEST;
        if (status == 429) return RATE_LIMITED;
        if (status >= 500) return SERVER_ERROR;
        return BAD_REQUEST;
    }
}
