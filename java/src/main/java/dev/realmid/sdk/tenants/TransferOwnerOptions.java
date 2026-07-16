package dev.realmid.sdk.tenants;

/**
 * Optional knobs for {@link TenantsClient#transferOwner} (ADR-076 direct
 * owner-pointer transfer). All fields optional.
 *
 * @param outgoingOwnerRole role the outgoing owner is demoted to after the
 *        transfer (defaults server-side to {@code admin}); ignored when
 *        {@code leaveEntirely} is true.
 * @param leaveEntirely     remove the outgoing owner from the tenant entirely
 *        instead of demoting them; {@code null} defers to the server default.
 */
public record TransferOwnerOptions(String outgoingOwnerRole, Boolean leaveEntirely) {
    public static TransferOwnerOptions empty() { return new TransferOwnerOptions(null, null); }
    public static TransferOwnerOptions demoteTo(String role) { return new TransferOwnerOptions(role, null); }
    public static TransferOwnerOptions leaving() { return new TransferOwnerOptions(null, true); }
}
