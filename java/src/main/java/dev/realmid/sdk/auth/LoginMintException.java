package dev.realmid.sdk.auth;

/**
 * Wraps a failure of the ADR-102 D10 mint that follows {@code /auth/login}, and
 * CARRIES THE SESSION login already created.
 *
 * <h2>Why the session travels on the exception</h2>
 *
 * <p>ADR-102 OQ8: the session is not litter, it is the RECOVERY ANCHOR, and that
 * is the point of splitting login from the mint. Every mint-time refusal is
 * recoverable from the one refresh token login handed back:
 *
 * <ul>
 *   <li>the role handler failed for org A &rarr; choose org B; failures are
 *       often per-org</li>
 *   <li>{@code 412 mfa_required} &rarr; verify, then mint</li>
 *   <li>{@code 412 mfa_registration_required} &rarr; enroll a first factor,
 *       then mint</li>
 *   <li>the ADR-092 session limit &rarr; the issuer returns the ACTIVE SESSION
 *       LIST and a revocation token, a surface that only makes sense while you
 *       still hold a usable refresh token</li>
 * </ul>
 *
 * <p>A mint-or-nothing {@code login} would strand exactly the users those
 * affordances exist for. Throwing a bare exception would have done precisely
 * that, because a caller's {@code catch} has no other handle on the session.
 *
 * <p>The session is NOT revoked. The residual risk — a partner whose role DB is
 * down for every tenant burning ADR-092 session slots — is bounded by D11's
 * retries and by the sessions' own expiry, and is the cheaper failure of the two.
 */
public class LoginMintException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final transient Session session;
    private final String tenantId;

    public LoginMintException(Session session, String tenantId, Throwable cause) {
        super("login succeeded but the mint for tenant " + tenantId + " failed: " + cause, cause);
        this.session = session;
        this.tenantId = tenantId;
    }

    /** The session {@code /auth/login} created, intact and usable. */
    public Session session() { return session; }

    /** The tenant the mint was attempted for. */
    public String tenantId() { return tenantId; }
}
