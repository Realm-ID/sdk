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
        // Wire field is "token" (server loginReq.Token); the SDK historically
        // sent "provider_token". The platform access token is auto-attached as
        // the Authorization bearer by HttpTransport — the two-step exchange of
        // ADR-051 §4.0: platform bearer authorizes the caller, this token
        // authenticates the user.
        body.put("token", req.providerToken());
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

    /**
     * SPEC §4.2.1 — build a {@link TokenManager} for a long-lived,
     * single-identity client, seeded with a refresh token the client already
     * holds (obtained out-of-band, e.g. at enrollment). The manager refreshes
     * against {@code POST /auth/token} directly on that token.
     */
    public TokenManager newTokenManager(String refreshToken) {
        return new TokenManager(this, refreshToken, null);
    }

    /** SPEC §4.2.1 — {@link #newTokenManager(String)} with options. */
    public TokenManager newTokenManager(String refreshToken, TokenManagerOptions opts) {
        return new TokenManager(this, refreshToken, opts);
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

    /**
     * Self-service MFA enroll — {@code POST /auth/mfa/enroll}. Current-user
     * op; dual-mode bearer (see {@link EnrollMfaRequest}). Returns the freshly
     * provisioned secret, otpauth QR URL, and recovery codes.
     */
    public MfaEnrollment enrollMfa(EnrollMfaRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (req.method() != null && !req.method().isEmpty()) body.put("method", req.method());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/enroll").body(body);
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, MfaEnrollment.class);
    }

    /**
     * Self-service MFA confirm — {@code POST /auth/mfa/confirm}. Current-user
     * op; dual-mode bearer. The server returns {@code {"status":"confirmed"}};
     * the SDK ignores the body and returns void (mirrors {@link #revokeSession}).
     */
    public void confirmMfa(ConfirmMfaRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (req.method() != null && !req.method().isEmpty()) body.put("method", req.method());
        body.put("code", req.code());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/confirm").body(body);
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        http.request(r);
    }

    /**
     * Self-service MFA disable — {@code DELETE /auth/mfa} with a step-up TOTP
     * code in the body. Current-user op; dual-mode bearer. The server returns
     * {@code {"status":"disabled"}}; the SDK returns void.
     */
    public void disableMfa(DisableMfaRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", req.code());
        HttpTransport.Request r = HttpTransport.Request.of("DELETE", "/auth/mfa").body(body);
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        http.request(r);
    }

    /**
     * Revoke all of the current user's sessions — {@code DELETE /auth/sessions}.
     * Current-user op; dual-mode bearer; no body. The server returns
     * {@code {"status":"ok"}}; the SDK returns void. Revocation-class tokens
     * are rejected by the server with {@code insufficient_scope}, surfaced as a
     * {@link RealmException}.
     */
    public void revokeAllSessions(RevokeAllSessionsRequest req) {
        HttpTransport.Request r = HttpTransport.Request.of("DELETE", "/auth/sessions");
        applyBearerTrio(r, req.userId(), req.userBearer(), req.onBehalfOfIp());
        http.request(r);
    }

    /**
     * Resolve the dual-mode bearer trio onto a request, mirroring the model
     * used by {@link #revokeSession} / {@link #listSessions}: exactly one of
     * {@code userBearer} (legacy mode, sent as the Authorization bearer) or
     * {@code userId} (BFF mode, sent as {@code X-On-Behalf-Of-User} while the
     * transport auto-attaches the platform token). {@code onBehalfOfIp} is
     * optional and only meaningful in BFF mode.
     */
    private void applyBearerTrio(HttpTransport.Request r, String userId, String userBearer, String onBehalfOfIp) {
        boolean hasBearer = userBearer != null && !userBearer.isEmpty();
        boolean hasUserId = userId != null && !userId.isEmpty();
        if (hasBearer == hasUserId) {
            throw new RealmException(ErrorCode.BAD_REQUEST,
                    "realmid: exactly one of userBearer or userId is required");
        }
        if (hasBearer) {
            r.bearer(userBearer);
        } else {
            r.header("x-on-behalf-of-user", userId);
            if (onBehalfOfIp != null && !onBehalfOfIp.isEmpty()) {
                r.header("x-on-behalf-of-ip", onBehalfOfIp);
            }
        }
    }

    private void attachOrigin(HttpTransport.Request r, String perCall) {
        String o = perCall != null && !perCall.isEmpty() ? perCall
                : (originResolver == null ? null : originResolver.get());
        if (o != null && !o.isEmpty()) r.header("origin", o);
    }
}
