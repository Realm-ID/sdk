package dev.realmid.sdk.userapikeys;

/**
 * Org-scope modes for an end-user API key (ADR-084 §6).
 *
 * <p>Kept as string constants rather than an enum: the wire value is a plain
 * string and a future mode must not turn an older SDK's deserialization into a
 * hard failure.
 */
public final class OrgScope {

    /**
     * A FROZEN allowlist of org ids, defaulting to just the user's current org.
     * Orgs the user joins later do NOT widen the key.
     */
    public static final String SELECTED = "selected";

    /**
     * FORWARD-INCLUSIVE: every org in the realm the user belongs to, now and in
     * future, resolved fresh at each exchange rather than snapshotted. A snapshot
     * would mean "all orgs as of Tuesday", which is neither thing a user could
     * mean.
     *
     * <p>Gated on the realm's {@code user_api_keys.allow_all_orgs} because it is
     * the one mode that widens with no human in the loop.
     */
    public static final String ALL = "all";

    private OrgScope() {}
}
