package dev.realmid.sdk.auth;

/**
 * Input to {@link AuthClient#serviceAccountOtpLogin} (owner ruling Q3, 2026-10-29). {@code tenantId}
 * is REQUIRED: a bot has no login walk to settle a tenant. {@code origin} is optional.
 */
public record ServiceAccountOtpLoginRequest(String identifier, String presented, String tenantId, String origin) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "ServiceAccountOtpLoginRequest[identifier=" + identifier + ", tenantId=" + tenantId + ", origin=" + origin + "]";
    }

    public static ServiceAccountOtpLoginRequest of(String identifier, String presented, String tenantId) {
        return new ServiceAccountOtpLoginRequest(identifier, presented, tenantId, null);
    }
}
