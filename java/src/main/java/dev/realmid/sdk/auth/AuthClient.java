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
        // Wire field is "mfa_challenge_token" (server MFAVerifyRequest required:
        // [mfa_challenge_token, code]). Go (sdk/go/auth.go) and TS
        // (sdk/ts/src/auth.ts) send the same key.
        body.put("mfa_challenge_token", req.challengeToken());
        body.put("code", req.code());
        body.put("method", req.method() == null ? "totp" : req.method());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/verify").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, Session.class);
    }

    /**
     * SPEC §X.4 — partner OTP single-factor login. Wraps {@code POST
     * /auth/login} with {@code grant_type=otp} (ADR-071 §4 renamed the grant
     * value from {@code otp_internal}; direct cutover — the issuer no longer
     * accepts the old name); {@code identifier} is an E.164 phone or email the
     * server resolves to a tenant-scoped user, {@code presented} is the
     * manager-issued OTP value the user typed. Realm precondition:
     * {@code otp_login_enabled = true}. Mirrors Go's {@code Auth.OTPLogin} /
     * TS's {@code auth.otpLogin}.
     */
    public Session otpLogin(OtpLoginRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("realm_id", realmId);
        body.put("grant_type", "otp");
        body.put("identifier", req.identifier());
        body.put("presented", req.presented());
        if (req.tenantId() != null && !req.tenantId().isEmpty()) body.put("tenant_id", req.tenantId());
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/login").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, Session.class);
    }

    /**
     * SPEC §X.5 — partner OTP second-factor verify. Thin wrapper over
     * {@link #mfaVerify(MFAVerifyRequest)} with {@code method=otp} pre-set
     * (ADR-071 §4 renamed the value from {@code otp_internal}); the
     * {@code mfaToken} comes from a prior {@code /auth/login} response that
     * advertised {@code "otp"} in {@code methods[]}. Realm precondition:
     * {@code otp_mfa_enabled = true} and the user is enrolled in {@code otp}.
     * Mirrors Go's {@code Auth.MFAVerifyOTP} / TS's {@code auth.mfaVerifyOtp}.
     */
    public Session mfaVerifyOtp(MfaVerifyOtpRequest req) {
        return mfaVerify(new MFAVerifyRequest(req.mfaToken(), req.presented(), "otp", req.origin()));
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
     * Self-service MFA enroll — refresh-authed {@code POST /auth/mfa/enroll}
     * (ADR-061). The user's {@code refreshToken} authorizes enrollment, so a
     * first-login user whose access token was withheld by the MFA gate can
     * still bootstrap a factor; the same call serves a post-login user
     * switching into an MFA-required tenant. The refresh travels in the body
     * and the platform token rides as the Authorization bearer (auto-attached
     * by {@link HttpTransport}), exactly mirroring {@link #token(TokenRequest)}.
     *
     * <p>{@code method} is optional (server defaults to {@code "totp"}).
     * Returns the freshly provisioned TOTP secret, an otpauth QR URL, recovery
     * codes, and an enroll-scoped {@code mfa_challenge_token} the caller
     * completes via {@link #mfaVerify(MFAVerifyRequest)} — there is no separate
     * confirm step.
     */
    public MfaEnrollment enrollMfa(SelfEnrollMfaRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("refresh_token", req.refreshToken());
        body.put("tenant_id", req.tenantId());
        if (req.method() != null && !req.method().isEmpty()) body.put("method", req.method());
        // No explicit bearer: HttpTransport auto-attaches the platform token,
        // and the refresh rides in the body (mirrors token()).
        HttpTransport.Request r = HttpTransport.Request.of("POST", "/auth/mfa/enroll").body(body);
        attachOrigin(r, req.origin());
        JsonNode raw = http.request(r);
        return http.mapper().convertValue(raw, MfaEnrollment.class);
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
