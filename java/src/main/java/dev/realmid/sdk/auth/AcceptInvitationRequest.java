package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#acceptInvitation} (ADR-117 D6): the sign-up link's {@code token},
 * the {@code username} to create (3-32 characters, case-folded, per-org unique) and the
 * {@code password} (12..1024 bytes, no composition rules). {@code origin} is optional, as on
 * {@link PasswordLoginRequest}. The token and password are secrets and are never printed.
 */
public record AcceptInvitationRequest(String token, String username, String password, String origin) {

    @Override
    public String toString() {
        return "AcceptInvitationRequest[username=" + username + "]";
    }
}
