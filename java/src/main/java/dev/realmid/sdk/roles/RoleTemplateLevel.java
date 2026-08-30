package dev.realmid.sdk.roles;

/**
 * The two levels a role template can be declared at (ADR-101 D1 / ADR-091 D2).
 *
 * <p>Constants rather than an enum: the wire value is what the server validates,
 * and an enum would turn a level this SDK version has not heard of into a
 * deserialization failure rather than a value the caller can still read.
 */
public final class RoleTemplateLevel {

    private RoleTemplateLevel() {}

    /** Governs realms — the catalog an admin tenant resolves against. */
    public static final String PLATFORM = "platform";
    /** Governs orgs — the catalog a platform realm's tenants resolve against. */
    public static final String TENANT = "tenant";
}
