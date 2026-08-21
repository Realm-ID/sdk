package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/**
 * Login / mfa-verify response (SPEC §4). Also doubles as the session record
 * returned by {@code listSessions} (sessions may have only id/createdAt).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Session(
        @JsonProperty("access_token") @JsonAlias("accessToken") String accessToken,
        @JsonProperty("refresh_token") @JsonAlias("refreshToken") String refreshToken,
        @JsonProperty("expires_in") @JsonAlias("expiresIn") long expiresIn,
        // SPEC §4.1 — absolute wall-clock expiry (unix seconds) of the returned
        // refresh token, past which it can no longer be rotated. 0 when the
        // issuer does not surface it (pre-refresh_exp issuers); callers that
        // size a session from it must fall back to their own ceiling.
        @JsonProperty("refresh_exp") @JsonAlias("refreshExp") long refreshExp,
        // ADR-070 — sliding-window idle-timeout duration (seconds). Each
        // authenticated use slides the window forward by idleTtl; 0 (absent)
        // means no idle timeout — treat as "disabled", not "expire now".
        @JsonProperty("idle_ttl") @JsonAlias("idleTtl") long idleTtl,
        @JsonProperty("expires_at") @JsonAlias("expiresAt") String expiresAt,
        // ADR-071 §8 — the owner/admin who minted the login OTP that produced
        // this service-account session (attribution/provenance). null for
        // human/provider logins and M2M sessions. Decoded from the issuer's
        // `initiated_by_user_id`.
        @JsonProperty("initiated_by_user_id") @JsonAlias("initiatedByUserId") String initiatedByUserId,
        Map<String, Object> user,
        List<TenantRef> tenants,
        String id,
        @JsonProperty("created_at") @JsonAlias("createdAt") String createdAt,
        // Wire field is `last_seen_at` (issuer httpapi.sessionDTO.LastSeenAt),
        // NOT `last_used_at`. The accessor keeps the lastUsedAt() name for API
        // stability and cross-language parity (Go SessionInfo.LastUsedAt).
        // Before this fix the property read `last_used_at`, so lastUsedAt()
        // always deserialized to null.
        @JsonProperty("last_seen_at") @JsonAlias({"lastSeenAt", "last_used_at", "lastUsedAt"}) String lastUsedAt,
        @JsonProperty("user_agent") @JsonAlias("userAgent") String userAgent,
        String ip,
        // ADR-062 — the human-readable device label supplied at login via the
        // X-Device-Name header (e.g. a CLI hostname), so a user can tell their
        // sessions apart before revoking one. null when the session was created
        // without one, and on every M2M session. Parity: Go
        // SessionInfo.DeviceName, TS SessionInfo.device_name.
        @JsonProperty("device_name") @JsonAlias("deviceName") String deviceName,
        // ADR-092 D5 — the caller holds more than one ACTIVE membership in a
        // realm that requires single-tenant membership and must give the
        // extras up. The login SUCCEEDED (access + refresh tokens are present),
        // so this is a reconciliation prompt, not an auth failure: refusing the
        // login would strand exactly the users the drain exists to resolve.
        // Settle it with realm.me().chooseTenant(...). false on every realm
        // with the knob off, which is every realm until a partner turns it on.
        @JsonProperty("tenant_choice_required") @JsonAlias("tenantChoiceRequired")
        boolean tenantChoiceRequired,
        // The memberships the D5 picker may choose between; null when absent.
        @JsonProperty("tenant_choices") @JsonAlias("tenantChoices")
        List<TenantChoice> tenantChoices
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TenantRef(
            String id,
            String role,
            @JsonProperty("display_name") @JsonAlias("displayName") String displayName) {}

    /** One option in the ADR-092 D5 single-tenant picker. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TenantChoice(
            @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
            @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
            // Marks a membership that CANNOT be given up: releasing it would
            // leave the tenant ownerless and `tenants.owner_user_id` is NOT
            // NULL. Do not offer it — the server refuses it regardless — the
            // way out is an ADR-076 ownership transfer first.
            @JsonProperty("is_owner") @JsonAlias("isOwner") boolean isOwner) {}
}
