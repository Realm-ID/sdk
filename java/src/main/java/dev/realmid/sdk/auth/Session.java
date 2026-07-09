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
        @JsonProperty("expires_at") @JsonAlias("expiresAt") String expiresAt,
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
        String ip
) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TenantRef(
            String id,
            String role,
            @JsonProperty("display_name") @JsonAlias("displayName") String displayName) {}
}
