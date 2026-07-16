package dev.realmid.sdk.tenants;

/**
 * Optional filters for {@link InvitationsClient#list} (SPEC §6.2, S-07).
 *
 * @param status exact match: pending|accepted|revoked|expired. Null omits it.
 */
public record InvitationListOpts(String status) {
    public static InvitationListOpts empty() { return new InvitationListOpts(null); }
    public static InvitationListOpts withStatus(String status) { return new InvitationListOpts(status); }
}
