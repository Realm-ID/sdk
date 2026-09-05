package dev.realmid.sdk.auth;

/**
 * Reports that YOUR {@link IdentityResolvedHandler} failed and the SDK
 * therefore refused the mint.
 *
 * <p><b>⚠️ Deliberately NOT a {@code RealmException}</b>, for the same reason
 * {@link ProductRolesException} / {@link ScopesException} are not: "your hook
 * failed" and "RealmID refused your mint" are different incidents and must
 * not look alike in your logs — one is your database, the other is ours.
 *
 * <p><b>Unlike its two siblings, this carries no {@code attempts} count.</b>
 * The hook is NOT retried — exactly one invocation per derived-claims
 * resolution — so there is nothing to count.
 *
 * <p>On the login lanes this rides the {@link LoginMintException} anchor
 * exactly as a {@link ProductRolesException} / {@link ScopesException} would;
 * see that class for why the session travels on the exception rather than
 * being discarded.
 */
public class IdentityResolvedException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String tenantId;
    private final String userId;
    private final AuthFlow flow;

    public IdentityResolvedException(String tenantId, String userId, AuthFlow flow, Throwable cause) {
        super("onIdentityResolved handler failed for tenant " + tenantId
                + " (flow=" + flow + "): " + cause, cause);
        this.tenantId = tenantId;
        this.userId = userId;
        this.flow = flow;
    }

    public String tenantId() { return tenantId; }

    public String userId() { return userId; }

    public AuthFlow flow() { return flow; }
}
