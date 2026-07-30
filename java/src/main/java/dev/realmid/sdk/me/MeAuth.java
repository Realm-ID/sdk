package dev.realmid.sdk.me;

/**
 * The end-user credential every {@link MeClient} call needs (ADR-092 D5).
 *
 * <p>Two modes, mirroring the rest of the SDK:
 * <ul>
 *   <li>DIRECT — {@link #bearer(String)}: the user's access JWT becomes the
 *       wire bearer.</li>
 *   <li>BFF — {@link #onBehalfOf(String)}: the realm's platform token stays the
 *       bearer and the user's <em>verified</em> access JWT rides as
 *       {@code X-User-Token} (ADR-056).</li>
 * </ul>
 *
 * <p>There is no user-id mode: a BARE user id is not an identity — the issuer
 * removed that in v0.66.0 and answers {@code 401 x_user_token_required}.
 *
 * @param userBearer the user's access JWT used AS the bearer, or null
 * @param userToken the user's verified access JWT forwarded as
 *                  {@code X-User-Token}, or null
 */
public record MeAuth(String userBearer, String userToken) {

    /** Direct mode — the user's access JWT is the wire bearer. */
    public static MeAuth bearer(String userAccessJwt) {
        return new MeAuth(userAccessJwt, null);
    }

    /** BFF mode — platform bearer plus the verified user JWT as X-User-Token. */
    public static MeAuth onBehalfOf(String verifiedUserAccessJwt) {
        return new MeAuth(null, verifiedUserAccessJwt);
    }
}
