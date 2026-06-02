package dev.realmid.sdk.platformtoken;

/**
 * A bootstrap credential the SDK exchanges once at {@code POST /auth/login}
 * for a platform session (ADR-057). Exactly one of {@code apiKey} /
 * {@code subjectToken} is populated, selected by {@code grantType}.
 */
public record Credential(String grantType, String apiKey, String subjectToken) {

    /** grant_type for the static platform API key. */
    public static final String GRANT_PLATFORM_API_KEY = "platform_api_key";
    /** grant_type for the workload-token exchange. */
    public static final String GRANT_TOKEN_EXCHANGE =
            "urn:ietf:params:oauth:grant-type:token-exchange";
    /** subject_token_type for the token-exchange grant. */
    public static final String SUBJECT_TOKEN_TYPE_JWT =
            "urn:ietf:params:oauth:token-type:jwt";

    /** Builds an API-key credential. */
    public static Credential ofApiKey(String key) {
        return new Credential(GRANT_PLATFORM_API_KEY, key, null);
    }

    /** Builds a token-exchange credential from a workload OIDC JWT. */
    public static Credential ofWorkloadToken(String subjectToken) {
        return new Credential(GRANT_TOKEN_EXCHANGE, null, subjectToken);
    }
}
