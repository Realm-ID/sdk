package dev.realmid.sdk.auth;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.http.HttpTransport;
import dev.realmid.sdk.pagination.Page;
import dev.realmid.sdk.pagination.PageReader;
import dev.realmid.sdk.pagination.Paginated;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/** SPEC §4. */
public final class AuthClient {

    private final HttpTransport http;
    private final String realmId;
    private final Supplier<String> originResolver;

    public AuthClient(HttpTransport http, String realmId, Supplier<String> originResolver) {
        this.http = http;
        this.realmId = realmId;
        this.originResolver = originResolver;
    }

    /** SPEC §4.1 — exchange a provider token for a realm-scoped session. */
    public Session login(LoginRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("method", req.method());
        body.put("provider_token", req.providerToken());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/login").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, Session.class);
    }

    /** SPEC §4.2. */
    public TokenResponse token(TokenRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("refresh_token", req.refreshToken());
        body.put("tenant_id", req.tenantId());
        if (req.customClaims() != null) body.put("custom_claims", req.customClaims());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/token").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, TokenResponse.class);
    }

    /** SPEC §4.3. */
    public Session mfaVerify(MFAVerifyRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("challenge_token", req.challengeToken());
        body.put("code", req.code());
        body.put("method", req.method() == null ? "totp" : req.method());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/verify").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, Session.class);
    }

    /** SPEC §4.4. */
    public Map<String, Object> logout(LogoutRequest req) {
        if (req == null) req = LogoutRequest.empty();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("refresh_token", req.refreshToken());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/logout").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        @SuppressWarnings("unchecked")
        Map<String, Object> out = http.mapper().convertValue(raw, Map.class);
        return out == null ? Map.of("status", "ok") : out;
    }

    /** SPEC §4.5. */
    public void revokeSession(String sessionId, String userBearer) {
        HttpTransport.Request r = HttpTransport.Request.of(
                "DELETE", "/auth/sessions/" + java.net.URLEncoder.encode(sessionId, java.nio.charset.StandardCharsets.UTF_8))
                .bearer(userBearer);
        http.request(r);
    }

    /** SPEC §4.6. Note: paginated wire shape per SPEC §7. */
    public Paginated<Session> listSessions(String userBearer) {
        return Paginated.of(opts -> {
            Map<String, Object> q = new LinkedHashMap<>();
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
            HttpTransport.Request r = HttpTransport.Request.of("GET", "/auth/sessions")
                    .query(q).bearer(userBearer);
            JsonNode raw = http.request(r);
            return PageReader.read(http.mapper(), raw, Session.class);
        });
    }

    /**
     * SPEC §10.1 / §10.4 — mint an MFA challenge token from an access
     * token. The middleware uses this to issue 412 envelopes on
     * MFA-protected paths without forcing the partner app to round-trip
     * through {@link #login} again.
     *
     * The server endpoint may not exist yet. On 404/501, this throws
     * {@link RealmException} with {@link ErrorCode#SERVER_ERROR} and the
     * message "mfa challenge mint not yet supported by server" — same
     * semantics as the TS/Go SDKs.
     */
    public MfaChallengeMint mintMfaChallenge(String accessToken) {
        // Empty body — the bearer identifies user, session, and realm.
        Map<String, Object> body = new LinkedHashMap<>();
        JsonNode raw;
        try {
            raw = http.request(HttpTransport.Request.of("POST", "/auth/mfa/challenge")
                    .bearer(accessToken).body(body));
        } catch (RealmException e) {
            if (e.getHttpStatus() == 404 || e.getHttpStatus() == 501) {
                throw new RealmException(ErrorCode.SERVER_ERROR,
                        "mfa challenge mint not yet supported by server", e);
            }
            throw e;
        }
        MFAChallenge c = http.mapper().convertValue(raw, MFAChallenge.class);
        if (c == null || c.mfaChallengeToken() == null || c.mfaChallengeToken().isEmpty()) {
            throw new RealmException(ErrorCode.SERVER_ERROR,
                    "mfa challenge mint not yet supported by server");
        }
        java.util.List<String> methods = c.methods();
        if (methods == null || methods.isEmpty()) methods = java.util.List.of("totp");
        return new MfaChallengeMint(c.mfaChallengeToken(), methods);
    }

    /** Result of {@link #mintMfaChallenge(String)} (SPEC §10.4). */
    public record MfaChallengeMint(String challengeToken, java.util.List<String> methods) {}

    private void attachOrigin(HttpTransport.Request r, String perCall) {
        String o = perCall != null && !perCall.isEmpty() ? perCall
                : (originResolver == null ? null : originResolver.get());
        if (o != null && !o.isEmpty()) r.header("origin", o);
    }
}
