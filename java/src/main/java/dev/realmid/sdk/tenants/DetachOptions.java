package dev.realmid.sdk.tenants;

/**
 * Options for {@code TenantsClient.detachDomain} and {@code OriginsClient.delete}
 * (ADR-049 amendment). The default signs nobody out.
 *
 * @param signOut also end every session of the tenant (domain detach) or realm
 *                (origin delete), for the lost or compromised address case.
 *                Sent as {@code ?sign_out=true} only when true.
 */
public record DetachOptions(boolean signOut) {
    public static DetachOptions defaults() { return new DetachOptions(false); }
}
