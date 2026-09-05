package dev.realmid.sdk.auth;

/**
 * Names the derived-claims mint an {@link IdentityResolvedEvent} was fired
 * for. Every value below reaches {@code mintProductRoles} or
 * {@code enrichRefreshMint} — see the design doc's §3.2 lane table.
 *
 * <p>{@code MFA_VERIFY} covers both {@code mfaVerify} and {@code mfaVerifyOtp}:
 * the latter delegates to the former, so it fires the hook once, not twice.
 *
 * <p>{@code TENANT_CHOICE} is {@code completeLogin} — the settlement of a
 * multi-tenant login, or a later tenant SWITCH on an already-minted session.
 * A single {@code login()} call that resolved immediately (single membership)
 * fires {@code LOGIN}, never {@code TENANT_CHOICE}.
 */
public enum AuthFlow {
    LOGIN("login"),
    OTP("otp"),
    PASSWORD("password"),
    MFA_VERIFY("mfa_verify"),
    TENANT_CHOICE("tenant_choice"),
    REFRESH("refresh");

    private final String wire;

    AuthFlow(String wire) {
        this.wire = wire;
    }

    /** The lane name used in log lines and doc comments, matching go/ts. */
    public String wire() { return wire; }

    @Override
    public String toString() { return wire; }
}
