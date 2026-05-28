package dev.realmid.sdk.apikeys;

/**
 * Create payload for {@code realm.apiKeys.create} (SPEC §6.5). {@code scope} is
 * required; {@code label} is an optional human-readable name. The create
 * response carries a one-time {@code value} secret (see {@link APIKey}).
 */
public record APIKeyCreate(String scope, String label) {
    public static APIKeyCreate of(String scope) {
        return new APIKeyCreate(scope, null);
    }

    public static APIKeyCreate of(String scope, String label) {
        return new APIKeyCreate(scope, label);
    }
}
