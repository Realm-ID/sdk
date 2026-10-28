package dev.realmid.sdk.me;

/**
 * The end-user credential every {@link MeClient} call needs (ADR-092 D5).
 *
 * <p>Escort form only (R60): the realm's platform token is always the bearer and the user's
 * <em>verified</em> access JWT rides as {@code X-User-Token} (ADR-056). The user-as-bearer mode is
 * REMOVED: the issuer answers a user JWT in the bearer slot with {@code 401 platform_bearer_required}.
 * A call with no {@code MeAuth} token uses the actor the realm carries ({@code Realm.withUserToken});
 * with neither it is an {@code ActorRequiredException} and nothing is sent.
 *
 * <p>There is no user-id mode: a BARE user id is not an identity.
 *
 * @param userToken the user's verified access JWT forwarded as {@code X-User-Token}, or null
 */
public record MeAuth(String userToken) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "MeAuth[redacted]";
    }

    /** Platform bearer plus the verified user JWT as X-User-Token. */
    public static MeAuth onBehalfOf(String verifiedUserAccessJwt) {
        return new MeAuth(verifiedUserAccessJwt);
    }
}
