package dev.realmid.sdk.sessions;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Owner/admin session-revocation surface (ADR-080 / issuer v0.50.0), reached as
 * {@code realm.sessions()}. Distinct from {@code AuthClient.revokeAllSessions},
 * which revokes the CURRENT user's own sessions. Both operations require the
 * {@code sessions:revoke} permission (owner implicit-all); the platform token is
 * auto-attached as the Authorization bearer by {@link HttpTransport}.
 */
public final class SessionsClient {
    private final HttpTransport http;
    private final String realmId;

    public SessionsClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /**
     * Force-log-out a specific member: every one of the target user's sessions
     * in the tenant's realm is revoked (POST
     * /tenants/{id}/users/{uid}/sessions/revoke). Owner/admin only
     * ({@code sessions:revoke}). A user not in the tenant yields
     * {@code RealmException(not_found)} (404).
     */
    public SessionRevokeResult revokeUser(String tenantId, String userId) {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/tenants/" + enc(tenantId) + "/users/" + enc(userId) + "/sessions/revoke"));
        return http.mapper().convertValue(raw, SessionRevokeResult.class);
    }

    /**
     * Realm-wide mass logout (POST /platforms/{realmId}/sessions/revoke-all) —
     * every session in the SDK's own realm is revoked (e.g. breach response).
     * The DB revocation is authoritative; the Redis active-session sets are
     * cleared realm-wide so no user trips the session-limit counter on next
     * login. Owner/admin only ({@code sessions:revoke} on the realm).
     */
    public SessionRevokeResult revokeAll() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/sessions/revoke-all"));
        return http.mapper().convertValue(raw, SessionRevokeResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
