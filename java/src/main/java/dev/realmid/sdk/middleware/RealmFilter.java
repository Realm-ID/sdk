package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Logging;
import dev.realmid.sdk.Realm;
import dev.realmid.sdk.RealmException;
import dev.realmid.sdk.auth.AuthClient;
import dev.realmid.sdk.auth.LoginRequest;
import dev.realmid.sdk.auth.LogoutRequest;
import dev.realmid.sdk.auth.MFAVerifyRequest;
import dev.realmid.sdk.auth.Session;
import dev.realmid.sdk.auth.TokenRequest;
import dev.realmid.sdk.auth.TokenResponse;
import dev.realmid.sdk.session.OrgSessionModes;
import dev.realmid.sdk.session.SessionKeys;
import dev.realmid.sdk.session.SessionStateStore;
import dev.realmid.sdk.tokens.TokenRevokedException;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.BufferedReader;
import java.io.IOException;
import java.lang.System.Logger.Level;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Servlet filter implementing SPEC §10. Auth ingress (login/logout/refresh/
 * mfa-verify) handled here; everything else falls through to bearer
 * verification, attaching {@link Claims} as request attribute
 * {@code realmid.claims}.
 */
public class RealmFilter implements Filter {

    public static final String CLAIMS_ATTR = "realmid.claims";

    /** Grace window on a {@code requireFresh} route — gives the client time to retry the original op after MFA verify. */
    static final Duration REQUIRE_FRESH_WINDOW = Duration.ofSeconds(30);

    private final MiddlewareConfig cfg;
    private final ObjectMapper mapper;
    /** Canonical JSON (sorted map keys) for the refresh fingerprint. */
    private final ObjectMapper canon = new ObjectMapper()
            .configure(com.fasterxml.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

    public RealmFilter(MiddlewareConfig cfg) {
        this.cfg = cfg;
        this.mapper = new ObjectMapper();
    }

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        if (!(req instanceof HttpServletRequest hreq) || !(res instanceof HttpServletResponse hres)) {
            chain.doFilter(req, res);
            return;
        }
        handle(hreq, hres, chain);
    }

    /** Public entry point so non-servlet wrappers can reuse the routing logic. */
    public void handle(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        String path = req.getRequestURI();
        String method = req.getMethod() == null ? "GET" : req.getMethod().toUpperCase();

        // 1. Exempt path?
        for (String pat : cfg.exemptPaths) {
            if (GlobMatcher.match(pat, path)) {
                if (chain != null) chain.doFilter(req, res);
                return;
            }
        }

        // 2-5. Auth ingress.
        if ("POST".equals(method) && path.equals(cfg.loginPath)) { handleLogin(req, res); return; }
        if ("POST".equals(method) && path.equals(cfg.logoutPath)) { handleLogout(req, res); return; }
        if ("POST".equals(method) && path.equals(cfg.refreshPath)) { handleRefresh(req, res); return; }
        if ("POST".equals(method) && path.equals(cfg.mfaVerifyPath)) { handleMfaVerify(req, res); return; }

        // 6. Bearer fall-through.
        String auth = req.getHeader("Authorization");
        if (auth == null || !auth.toLowerCase().startsWith("bearer ")) {
            warnAuth(req, "missing bearer token");
            sendError(res, 401, ErrorCode.UNAUTHORIZED.wire(), "missing bearer token", null);
            return;
        }
        String token = auth.substring("bearer ".length()).trim();
        Claims claims;
        try {
            claims = cfg.realm.verify(token);
        } catch (RealmException e) {
            warnAuth(req, "verify failed: " + e.getCode().wire());
            sendError(res, 401, e.getCode().wire(), e.getMessage(), null);
            return;
        }
        // 6a (SPEC 10.1): the session check - revoked OR superseded - on the same
        // bearer, through the realm's OWN TokensClient, before the MFA check and
        // before the claims are attached. A hit is a 401, never the 412.
        try {
            cfg.realm.tokens().gateRequest(token);
        } catch (TokenRevokedException e) {
            warnAuth(req, "access token revoked");
            Map<String, Object> sib = new LinkedHashMap<>();
            sib.put("revoked", Boolean.TRUE);
            sendError(res, 401, ErrorCode.UNAUTHORIZED.wire(), "access token revoked", sib);
            return;
        }
        // MFA-protected? (SPEC §10.4)
        MFARule rule = findMfaRule(path);
        if (rule != null) {
            MfaVerdict verdict = evaluateMfaFreshness(claims, rule, cfg.mfaDefaultMaxAge);
            if (verdict != null) {
                respondMfaRequired(req, res, token, verdict);
                return;
            }
        }
        req.setAttribute(CLAIMS_ATTR, claims);
        if (chain != null) chain.doFilter(req, res);
    }

    private MFARule findMfaRule(String path) {
        for (MFARule r : cfg.mfaProtectedPaths) {
            if (GlobMatcher.matchPlaceholders(r.path(), path)) return r;
        }
        return null;
    }

    /** Source of the MFA proof — only {@code TIMESTAMP} can satisfy {@code requireFresh}. */
    private enum MfaProofSource { NONE, MARKER_FALLBACK, TIMESTAMP }

    private record MfaProof(long at, MfaProofSource source) {}

    private record MfaVerdict(MFAGateReason reason, long maxAgeSeconds) {}

    /**
     * Read MFA proof from claims, with a backward-compat fallback:
     *  - explicit {@code mfa_at} -> source {@code TIMESTAMP}.
     *  - legacy {@code amr ⊇ ["mfa"]} or {@code acr == "urn:realmid:mfa"}
     *    -> source {@code MARKER_FALLBACK}, treated as freshly minted so
     *    pre-{@code mfa_at} servers still pass {@code maxAge} gates.
     *    {@code requireFresh} still rejects it (no timestamp = no proof).
     *  - neither -> source {@code NONE}.
     */
    static MfaProof readMfaProof(Claims claims, long nowSec) {
        if (claims == null) return new MfaProof(0L, MfaProofSource.NONE);
        if (claims.mfaAt() > 0) return new MfaProof(claims.mfaAt(), MfaProofSource.TIMESTAMP);
        if (claims.hasMfa()) return new MfaProof(nowSec, MfaProofSource.MARKER_FALLBACK);
        return new MfaProof(0L, MfaProofSource.NONE);
    }

    /**
     * Evaluate whether {@code claims} carries fresh-enough MFA proof for
     * {@code rule}. Returns {@code null} when the gate passes; an
     * {@link MfaVerdict} describing the failure mode when it doesn't.
     */
    static MfaVerdict evaluateMfaFreshness(Claims claims, MFARule rule, Duration defaultMaxAge) {
        long nowSec = Instant.now().getEpochSecond();
        MfaProof proof = readMfaProof(claims, nowSec);
        long age = nowSec - proof.at();

        // requireFresh — must have an explicit mfa_at within the grace window.
        if (rule.requireFresh()) {
            if (proof.source() == MfaProofSource.TIMESTAMP && age <= REQUIRE_FRESH_WINDOW.getSeconds()) {
                return null;
            }
            return new MfaVerdict(MFAGateReason.FRESH_REQUIRED, 0L);
        }

        Duration maxAge = rule.maxAge();
        long maxAgeSec = maxAge == null ? 0L : maxAge.getSeconds();
        if (maxAgeSec <= 0) {
            // null/zero -> use the realm-default.
            maxAgeSec = defaultMaxAge == null ? 0L : defaultMaxAge.getSeconds();
        }

        // maxAge of 0 collapses to requireFresh semantics.
        if (maxAgeSec <= 0) {
            if (proof.source() == MfaProofSource.TIMESTAMP && age <= REQUIRE_FRESH_WINDOW.getSeconds()) {
                return null;
            }
            MFAGateReason reason = proof.source() == MfaProofSource.NONE
                    ? MFAGateReason.NO_MFA : MFAGateReason.STALE_MFA;
            return new MfaVerdict(reason, 0L);
        }

        if (proof.source() == MfaProofSource.NONE) {
            return new MfaVerdict(MFAGateReason.NO_MFA, maxAgeSec);
        }
        if (age > maxAgeSec) {
            return new MfaVerdict(MFAGateReason.STALE_MFA, maxAgeSec);
        }
        return null;
    }

    private void respondMfaRequired(HttpServletRequest req, HttpServletResponse res,
                                    String accessToken, MfaVerdict verdict) throws IOException {
        String challengeToken = "";
        List<String> methods = List.of("totp");
        try {
            AuthClient.MfaChallengeMint ch = cfg.realm.auth().mintMfaChallenge(accessToken);
            if (ch != null) {
                if (ch.challengeToken() != null) challengeToken = ch.challengeToken();
                if (ch.methods() != null && !ch.methods().isEmpty()) methods = ch.methods();
            }
        } catch (RuntimeException ex) {
            var logger = cfg.realm.logger();
            if (logger != null && logger.isLoggable(Level.WARNING)) {
                logger.log(Level.WARNING, "realmid: mfa challenge mint unavailable path={0} reason={1}",
                        req.getRequestURI(), ex.getMessage());
            }
        }
        Map<String, Object> sib = new LinkedHashMap<>();
        sib.put("mfa_challenge_token", challengeToken);
        sib.put("methods", methods);
        sib.put("max_age_seconds", verdict.maxAgeSeconds());
        sib.put("reason", verdict.reason().wire());
        sendError(res, 412, ErrorCode.MFA_REQUIRED.wire(), "MFA required for this resource", sib);
    }

    private void handleLogin(HttpServletRequest req, HttpServletResponse res) throws IOException {
        Map<String, Object> body = readJson(req);
        String method = String.valueOf(body.getOrDefault("method", "firebase"));
        String providerToken = String.valueOf(body.getOrDefault("provider_token",
                body.getOrDefault("providerToken", "")));
        try {
            Session s = cfg.realm.auth().login(new LoginRequest(method, providerToken, null));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", s.accessToken());
            out.put("expires_in", s.expiresIn());
            out.put("user", s.user());
            out.put("tenants", s.tenants());
            out.put("org_session_mode", orgSessionMode(s.accessToken()));
            deliverRefresh(res, out, s.refreshToken());
            sendJson(res, 200, out);
        } catch (RealmException e) {
            if (e.getCode() == ErrorCode.MFA_REQUIRED) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("status", "mfa_required");
                out.put("mfa_challenge_token", e.getDetails().get("mfa_challenge_token"));
                Object methods = e.getDetails().get("methods");
                if (methods == null) methods = e.getDetails().get("mfa_methods");
                out.put("methods", methods);
                sendJson(res, 200, out);
                return;
            }
            sendError(res, e.getHttpStatus() > 0 ? e.getHttpStatus() : 500,
                    e.getCode().wire(), e.getMessage(), e.getDetails());
        }
    }

    /**
     * The realm's org-session mode as the browser-facing body reports it
     * (SPEC 6.7.3): read through the discovery cache for the realm the token's
     * {@code iss} names; {@code concurrent} when it cannot be read.
     */
    private String orgSessionMode(String accessToken) {
        try {
            SessionKeys.Peek p = SessionKeys.peek(accessToken);
            String m = cfg.realm.orgSessionModes().mode(p == null ? null : p.iss());
            return OrgSessionModes.EXCLUSIVE.equals(m) ? OrgSessionModes.EXCLUSIVE : OrgSessionModes.CONCURRENT;
        } catch (RuntimeException e) {
            return OrgSessionModes.CONCURRENT;
        }
    }

    private void handleLogout(HttpServletRequest req, HttpServletResponse res) throws IOException {
        // SPEC 10.1 step 3a. The ISSUER names the session to revoke (the logout
        // response's sid / revoked_sids), keyed by the refresh-token holder; the
        // bearer is only a fallback and only if it verifies UNEXPIRED. Logout
        // never 401s.
        List<String> candidates = readRefreshCandidates(req);
        if (cfg.tokenDelivery == TokenDelivery.BODY) {
            Map<String, Object> lb = readJson(req);
            Object br = lb.get("refresh_token");
            if (br == null) br = lb.get("refreshToken");
            if (br instanceof String s && !s.isEmpty()) candidates = List.of(s);
        }
        String bearer = bearerOrNull(req);
        // Revoke EVERY candidate, not just the first. During a cookieDomain
        // migration the browser holds two, and revoking only the one the old
        // first-match read returned left a live session behind a cookie the
        // user could neither see nor clear.
        for (String refresh : candidates) {
            try {
                cfg.realm.auth().logout(new LogoutRequest(refresh, null, bearer));
            } catch (RuntimeException ignored) { /* best effort; logout() already tried the bearer fallback */ }
        }
        if (candidates.isEmpty()) cfg.realm.auth().revokeByVerifiedBearer(bearer);
        if (cfg.tokenDelivery == TokenDelivery.COOKIE) clearRefreshCookie(res);
        sendJson(res, 200, Map.of("status", "ok"));
    }

    private static String bearerOrNull(HttpServletRequest req) {
        String auth = req.getHeader("Authorization");
        if (auth == null || !auth.toLowerCase().startsWith("bearer ")) return null;
        String t = auth.substring("bearer ".length()).trim();
        return t.isEmpty() ? null : t;
    }

    // ---- refresh single-flight (SPEC 10.1 step 4a / 4b) ----

    private static final Duration LOCK_TTL = Duration.ofSeconds(15); // mint bound (10 s) + 5 s: the bound starts after acquire + a reload read
    private static final Duration RESULT_TTL = Duration.ofSeconds(5);
    private static final long MINT_BOUND_SECONDS = 10;
    private static final String MFA_FINGERPRINT = "mfa-verify";

    private static final java.util.concurrent.ExecutorService MINT_POOL =
            java.util.concurrent.Executors.newCachedThreadPool(r -> {
                Thread t = new Thread(r, "realmid-refresh-mint");
                t.setDaemon(true);
                return t;
            });

    /** What a winner stored for its losers: the mint result or the error, plus the request fingerprint. */
    private record Outcome(String fp, boolean ok, int status, String code, String message,
                           Map<String, Object> details, String accessToken, Object expiresIn,
                           String tenantId, String role, String refreshToken, String minted) {

        static Outcome success(String fp, TokenResponse t, String minted) {
            return new Outcome(fp, true, 200, null, null, null, t.accessToken(), t.expiresIn(),
                    t.tenantId(), t.role(), t.refreshToken(), minted);
        }

        static Outcome error(String fp, int status, String code, String message, Map<String, Object> details) {
            return new Outcome(fp, false, status, code, message, details, null, null, null, null, null, null);
        }

        /** Rotated iff the response's refresh token is non-empty and differs from the candidate that minted. */
        boolean rotated() {
            return ok && refreshToken != null && !refreshToken.isEmpty() && !refreshToken.equals(minted);
        }

        byte[] encode(ObjectMapper m) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("fp", fp);
            o.put("ok", ok);
            o.put("status", status);
            o.put("code", code);
            o.put("message", message);
            o.put("details", details);
            o.put("access_token", accessToken);
            o.put("expires_in", expiresIn);
            o.put("tenant_id", tenantId);
            o.put("role", role);
            o.put("refresh_token", refreshToken);
            o.put("minted", minted);
            try {
                return m.writeValueAsBytes(o);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }

        @SuppressWarnings("unchecked")
        static Outcome decode(ObjectMapper m, byte[] b) throws IOException {
            Map<String, Object> o = m.readValue(b, Map.class);
            return new Outcome((String) o.get("fp"), Boolean.TRUE.equals(o.get("ok")),
                    o.get("status") instanceof Number n ? n.intValue() : 500,
                    (String) o.get("code"), (String) o.get("message"), (Map<String, Object>) o.get("details"),
                    (String) o.get("access_token"), o.get("expires_in"), (String) o.get("tenant_id"),
                    (String) o.get("role"), (String) o.get("refresh_token"), (String) o.get("minted"));
        }
    }

    private String fingerprint(String tenantId, Map<String, Object> custom) {
        try {
            return tenantId + "|" + (custom == null ? "" : canon.writeValueAsString(custom));
        } catch (IOException e) {
            return tenantId + "|" + custom;
        }
    }

    private void handleRefresh(HttpServletRequest req, HttpServletResponse res) throws IOException {
        List<String> candidates = readRefreshCandidates(req);
        Map<String, Object> body = readJson(req);
        if (cfg.tokenDelivery == TokenDelivery.BODY) {
            Object br = body.get("refresh_token");
            if (br == null) br = body.get("refreshToken");
            if (br instanceof String s && !s.isEmpty()) candidates = List.of(s);
        }
        String refresh = candidates.isEmpty() ? null : candidates.get(0);
        if (refresh == null || refresh.isEmpty()) {
            sendError(res, 401, ErrorCode.UNAUTHORIZED.wire(), "refresh token missing", null);
            return;
        }
        Object tenantObj = body.get("tenant_id");
        if (tenantObj == null) tenantObj = body.get("tenantId");
        if (tenantObj == null || String.valueOf(tenantObj).isEmpty()) {
            sendError(res, 400, ErrorCode.TENANT_REQUIRED.wire(), "tenant_id required", null);
            return;
        }
        String tenantId = String.valueOf(tenantObj);
        @SuppressWarnings("unchecked")
        Map<String, Object> custom = (Map<String, Object>) (body.get("custom_claims") != null
                ? body.get("custom_claims") : body.get("customClaims"));
        String fp = fingerprint(tenantId, custom);
        String lockKey = SessionKeys.lockKey(refresh);
        String outKey = SessionKeys.outcomeKey(refresh);
        SessionStateStore store = cfg.realm.sessionStore();

        SessionStateStore.RefreshLock lock;
        try {
            lock = store.acquireRefreshLock(lockKey, LOCK_TTL);
        } catch (RuntimeException e) {
            // Minting unlocked is the bug this step removes.
            sendError(res, 503, ErrorCode.SERVER_ERROR.wire(), "session store unavailable", null);
            return;
        }
        if (!lock.acquired()) {
            Outcome o = awaitOutcome(store, outKey);
            if (o == null) {
                sendError(res, 503, ErrorCode.SERVER_ERROR.wire(), "refresh in progress", null);
                return;
            }
            respondToOutcome(res, o, fp);
            return;
        }
        try {
            // A request that lost the previous winner's response (a reload) is
            // served the stored outcome, not a second mint of a spent token.
            Outcome prior = readOutcome(store, outKey);
            if (prior != null) {
                respondToOutcome(res, prior, fp);
                return;
            }
            Outcome o = mintBounded(candidates, tenantId, custom, fp);
            try {
                store.putRefreshResult(outKey, o.encode(mapper), RESULT_TTL);
            } catch (RuntimeException e) {
                warnAuth(req, "refresh outcome not stored: " + e.getMessage());
            }
            // SPEC 4b: only a ROTATING refresh refuses the session's older tokens.
            if (o.rotated()) cfg.realm.tokens().recordRefresh(o.accessToken());
            respond(res, o);
        } finally {
            try {
                lock.release().run();
            } catch (RuntimeException ignored) { /* the TTL frees it */ }
        }
    }

    /** Runs the candidate loop on a thread detached from the request, bounded at 10 s. */
    private Outcome mintBounded(List<String> candidates, String tenantId, Map<String, Object> custom, String fp) {
        java.util.concurrent.Future<Outcome> f = MINT_POOL.submit(() -> mint(candidates, tenantId, custom, fp));
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(MINT_BOUND_SECONDS);
        boolean interrupted = false;
        try {
            while (true) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    f.cancel(true);
                    return Outcome.error(fp, 504, ErrorCode.SERVER_ERROR.wire(), "refresh timed out", null);
                }
                try {
                    return f.get(left, java.util.concurrent.TimeUnit.NANOSECONDS);
                } catch (InterruptedException e) {
                    interrupted = true; // a cancelled request must not abandon a rotation in flight
                } catch (java.util.concurrent.TimeoutException e) {
                    // loop re-checks the deadline
                } catch (java.util.concurrent.ExecutionException e) {
                    return Outcome.error(fp, 500, ErrorCode.SERVER_ERROR.wire(),
                            String.valueOf(e.getCause() == null ? e.getMessage() : e.getCause().getMessage()), null);
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private Outcome mint(List<String> candidates, String tenantId, Map<String, Object> custom, String fp) {
        // Try each candidate until one mints. With the ordinary single cookie
        // this is exactly the old behaviour, including which error surfaces;
        // with a shadowed jar it is the difference between a working session
        // and a permanent, unrecoverable logout. The FIRST failure is what we
        // report, so no partner's error handling changes shape.
        TokenResponse t = null;
        String minted = null;
        RealmException firstErr = null;
        for (String candidate : candidates) {
            try {
                t = cfg.realm.auth().token(new TokenRequest(candidate, tenantId, custom, null));
                minted = candidate;
                break;
            } catch (RealmException e) {
                if (firstErr == null) firstErr = e;
            }
        }
        if (t == null) {
            RealmException e = firstErr;
            return Outcome.error(fp, e.getHttpStatus() > 0 ? e.getHttpStatus() : 500,
                    e.getCode().wire(), e.getMessage(), e.getDetails());
        }
        // The derived claims (ADR-102 product_roles, ADR-097 scope) are resolved
        // PER MINT, and a REFRESH IS A MINT. A handler failure REFUSES the
        // refresh: minting without the claim hands back a token every gate reads
        // as "denied".
        try {
            t = cfg.realm.auth().enrichRefreshMint(t, tenantId);
        } catch (RealmException e) {
            return Outcome.error(fp, e.getHttpStatus() > 0 ? e.getHttpStatus() : 500,
                    e.getCode().wire(), e.getMessage(), e.getDetails());
        } catch (RuntimeException e) {
            // ProductRolesException / ScopesException are deliberately NOT
            // RealmExceptions, so they surface as a server_error.
            return Outcome.error(fp, 500, ErrorCode.SERVER_ERROR.wire(), e.getMessage(), null);
        }
        return Outcome.success(fp, t, minted);
    }

    private Outcome readOutcome(SessionStateStore store, String outKey) {
        try {
            java.util.Optional<byte[]> b = store.getRefreshResult(outKey);
            return b.isPresent() ? Outcome.decode(mapper, b.get()) : null;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** Polls the winner's outcome every cfg.refreshPollMillis, at most cfg.refreshPollTries times. */
    private Outcome awaitOutcome(SessionStateStore store, String outKey) {
        for (int i = 0; i < cfg.refreshPollTries; i++) {
            Outcome o = readOutcome(store, outKey);
            if (o != null) return o;
            try {
                Thread.sleep(cfg.refreshPollMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return readOutcome(store, outKey);
    }

    /** Same fingerprint: the winner's response. Different: its error, or a 503 retry carrying its rotated token. */
    private void respondToOutcome(HttpServletResponse res, Outcome o, String myFp) throws IOException {
        if (!o.ok() || myFp.equals(o.fp())) {
            respond(res, o);
            return;
        }
        // The loser does NOT mint: it hands over the winner's rotated token (the
        // SAME Set-Cookie / body token the winner's response carries, so response
        // order cannot matter) and asks the client to retry with it.
        Map<String, Object> sib = new LinkedHashMap<>();
        sib.put("retry", Boolean.TRUE);
        if (cfg.tokenDelivery == TokenDelivery.BODY) {
            if (o.refreshToken() != null) sib.put("refresh_token", o.refreshToken());
        } else if (o.refreshToken() != null && !o.refreshToken().isEmpty()) {
            setRefreshCookie(res, o.refreshToken());
        }
        sendError(res, 503, ErrorCode.SERVER_ERROR.wire(), "refresh superseded, retry", sib);
    }

    private void respond(HttpServletResponse res, Outcome o) throws IOException {
        if (!o.ok()) {
            sendError(res, o.status(), o.code(), o.message(), o.details());
            return;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("access_token", o.accessToken());
        out.put("expires_in", o.expiresIn());
        out.put("tenant_id", o.tenantId());
        out.put("role", o.role());
        out.put("org_session_mode", orgSessionMode(o.accessToken()));
        deliverRefresh(res, out, o.refreshToken());
        sendJson(res, 200, out);
    }

    // ---- MFA verify under the refresh lock (SPEC 10.1 step 5) ----

    private void handleMfaVerify(HttpServletRequest req, HttpServletResponse res) throws IOException {
        Map<String, Object> body = readJson(req);
        String challenge = String.valueOf(body.getOrDefault("challenge_token",
                body.getOrDefault("challengeToken", "")));
        String code = String.valueOf(body.getOrDefault("code", ""));
        List<String> candidates = readRefreshCandidates(req);
        if (cfg.tokenDelivery == TokenDelivery.BODY) {
            Object br = body.get("refresh_token");
            if (br == null) br = body.get("refreshToken");
            if (br instanceof String s && !s.isEmpty()) candidates = List.of(s);
        }
        SessionStateStore store = cfg.realm.sessionStore();
        SessionStateStore.RefreshLock lock = null;
        String outKey = null;
        if (!candidates.isEmpty()) {
            // The issuer's MFA verify ROTATES the session's refresh token, so it
            // takes the same lock as refresh. It never adopts a refresh outcome
            // (its challenge is single-use and not yet consumed): it waits for
            // the LOCK, then calls the issuer.
            String first = candidates.get(0);
            outKey = SessionKeys.outcomeKey(first);
            for (int i = 0; i < cfg.refreshPollTries && lock == null; i++) {
                SessionStateStore.RefreshLock l;
                try {
                    l = store.acquireRefreshLock(SessionKeys.lockKey(first), LOCK_TTL);
                } catch (RuntimeException e) {
                    sendError(res, 503, ErrorCode.SERVER_ERROR.wire(), "session store unavailable", null);
                    return;
                }
                if (l.acquired()) {
                    lock = l;
                } else {
                    try {
                        Thread.sleep(cfg.refreshPollMillis);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            if (lock == null) {
                sendError(res, 503, ErrorCode.SERVER_ERROR.wire(), "refresh in progress", null);
                return;
            }
        }
        try {
            Session s = cfg.realm.auth().mfaVerify(MFAVerifyRequest.of(challenge, code));
            if (lock != null && s.refreshToken() != null && !s.refreshToken().isEmpty()) {
                // A refresh loser waiting on this key takes the different-fingerprint
                // branch and is handed the rotated token.
                try {
                    store.putRefreshResult(outKey, new Outcome(MFA_FINGERPRINT, true, 200, null, null, null,
                            null, null, null, null, s.refreshToken(), candidates.get(0)).encode(mapper), RESULT_TTL);
                } catch (RuntimeException e) {
                    warnAuth(req, "mfa outcome not stored: " + e.getMessage());
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", s.accessToken());
            out.put("expires_in", s.expiresIn());
            out.put("user", s.user());
            out.put("tenants", s.tenants());
            out.put("org_session_mode", orgSessionMode(s.accessToken()));
            deliverRefresh(res, out, s.refreshToken());
            sendJson(res, 200, out);
        } catch (RealmException e) {
            sendError(res, e.getHttpStatus() > 0 ? e.getHttpStatus() : 500,
                    e.getCode().wire(), e.getMessage(), e.getDetails());
        } finally {
            if (lock != null) {
                try {
                    lock.release().run();
                } catch (RuntimeException ignored) { /* the TTL frees it */ }
            }
        }
    }

    // ---- delivery helpers ----

    private void deliverRefresh(HttpServletResponse res, Map<String, Object> body, String refresh) {
        if (refresh == null) return;
        if (cfg.tokenDelivery == TokenDelivery.BODY) {
            body.put("refresh_token", refresh);
        } else {
            setRefreshCookie(res, refresh);
        }
    }

    private void setRefreshCookie(HttpServletResponse res, String value) {
        // Evict any twin at another scope before writing the live value.
        // Reading every candidate keeps a stranded browser working; this is
        // what actually cleans up, so the jar converges to one cookie.
        evictShadowRefreshCookies(res);
        StringBuilder sb = new StringBuilder();
        sb.append(cfg.cookieName).append('=').append(value);
        sb.append("; HttpOnly; Path=/");
        if (cfg.cookieSameSite != null) sb.append("; SameSite=").append(cfg.cookieSameSite);
        if (cfg.cookieSecure) sb.append("; Secure");
        if (cfg.cookieDomain != null) sb.append("; Domain=").append(cfg.cookieDomain);
        res.addHeader("Set-Cookie", sb.toString());
    }

    private void clearRefreshCookie(HttpServletResponse res) {
        // Logout must clear EVERY scope. Clearing only the configured one is
        // why signing out and back in did not recover a stranded browser: the
        // shadow cookie survived and went straight back to winning the read.
        evictShadowRefreshCookies(res);
        StringBuilder sb = new StringBuilder();
        sb.append(cfg.cookieName).append("=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        if (cfg.cookieSameSite != null) sb.append("; SameSite=").append(cfg.cookieSameSite);
        if (cfg.cookieSecure) sb.append("; Secure");
        if (cfg.cookieDomain != null) sb.append("; Domain=").append(cfg.cookieDomain);
        res.addHeader("Set-Cookie", sb.toString());
    }

    /**
     * Expires the refresh cookie at every scope this deployment is NOT
     * currently writing to.
     *
     * <p>Setting cookieDomain always evicts the host-only twin: that is the
     * common migration (the default is host-only) and the one scope we can
     * name without being told. The reverse — tightening or removing a domain —
     * is not discoverable, because the wider cookie is invisible to a config
     * that no longer writes it; that is what cookieDomainMigrateFrom is for.
     */
    private void evictShadowRefreshCookies(HttpServletResponse res) {
        List<String> scopes = new ArrayList<>();
        if (cfg.cookieDomain != null) scopes.add(""); // the host-only twin
        scopes.addAll(cfg.cookieDomainMigrateFrom);
        for (String d : scopes) {
            // Compare with the leading dot trimmed: ".example.com" and
            // "example.com" are the SAME scope (the dot has been meaningless
            // since RFC 6265 superseded RFC 2109). A raw compare would let a
            // partner who spelled the two settings differently delete their own
            // live cookie on every write — the same self-inflicted logout this
            // change exists to fix.
            if (sameScope(d, cfg.cookieDomain)) continue;
            StringBuilder sb = new StringBuilder();
            sb.append(cfg.cookieName)
              .append("=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
            if (cfg.cookieSameSite != null) sb.append("; SameSite=").append(cfg.cookieSameSite);
            if (cfg.cookieSecure) sb.append("; Secure");
            if (!d.isEmpty()) sb.append("; Domain=").append(d);
            res.addHeader("Set-Cookie", sb.toString());
        }
    }

    private static boolean sameScope(String a, String b) {
        String x = a == null ? "" : (a.startsWith(".") ? a.substring(1) : a);
        String y = b == null ? "" : (b.startsWith(".") ? b.substring(1) : b);
        return x.equals(y);
    }

    /**
     * Caps how many same-named cookies we will try in one request. A browser
     * can legitimately hold two (host-only + domain-scoped) during a
     * cookieDomain migration; more than that is a stuffed jar, and an uncapped
     * loop would let anyone amplify one request into N issuer calls.
     */
    private static final int MAX_REFRESH_CANDIDATES = 3;

    /**
     * Returns EVERY candidate refresh token on the request, in the order the
     * browser sent them, deduplicated and capped.
     *
     * <p>Why a list and not a value: two cookies of the same name at different
     * scopes are distinct jar entries, and RFC 6265 §5.4 orders the Cookie
     * header by path length then by CREATION time — so with both at Path=/ the
     * OLDER one arrives first. Returning that first match (as this method used
     * to) permanently pins the filter to the stale token: rotation only ever
     * updates one of the two, and the frozen one keeps winning the read.
     *
     * <p>Trying each candidate is safe against this issuer: an unrecognised
     * refresh hash resolves to nothing and comes back 401 refresh_invalid —
     * there is no reuse detection that revokes the session family on replay
     * (verified 2026-07-28). If that ever changes this becomes actively
     * dangerous and must be revisited.
     */
    private List<String> readRefreshCandidates(HttpServletRequest req) {
        if (cfg.tokenDelivery != TokenDelivery.COOKIE) {
            return List.of(); // body delivery handled in handleRefresh
        }
        Cookie[] cookies = req.getCookies();
        if (cookies == null) return List.of();
        List<String> out = new ArrayList<>(MAX_REFRESH_CANDIDATES);
        for (Cookie c : cookies) {
            if (!cfg.cookieName.equals(c.getName())) continue;
            String v = c.getValue();
            if (v == null || v.isEmpty() || out.contains(v)) continue;
            out.add(v);
            if (out.size() == MAX_REFRESH_CANDIDATES) break;
        }
        return out;
    }

    private String readRefresh(HttpServletRequest req) {
        List<String> all = readRefreshCandidates(req);
        return all.isEmpty() ? null : all.get(0);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readJson(HttpServletRequest req) throws IOException {
        BufferedReader r = req.getReader();
        if (r == null) return new LinkedHashMap<>();
        StringBuilder sb = new StringBuilder();
        char[] buf = new char[1024];
        int n;
        while ((n = r.read(buf)) >= 0) sb.append(buf, 0, n);
        if (sb.length() == 0) return new LinkedHashMap<>();
        try {
            JsonNode node = mapper.readTree(sb.toString());
            if (node == null || !node.isObject()) return new LinkedHashMap<>();
            return mapper.convertValue(node, Map.class);
        } catch (IOException e) {
            return new LinkedHashMap<>();
        }
    }

    private void sendJson(HttpServletResponse res, int status, Object body) throws IOException {
        res.setStatus(status);
        res.setContentType("application/json; charset=utf-8");
        byte[] out = mapper.writeValueAsBytes(body);
        res.setContentLength(out.length);
        res.getOutputStream().write(out);
    }

    private void sendError(HttpServletResponse res, int status, String code, String msg, Map<String, Object> sib) throws IOException {
        Map<String, Object> body = new LinkedHashMap<>();
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("code", code);
        err.put("message", msg);
        body.put("error", err);
        if (sib != null) {
            for (Map.Entry<String, Object> e : sib.entrySet()) {
                if ("error".equals(e.getKey())) continue;
                body.put(e.getKey(), e.getValue());
            }
        }
        sendJson(res, status, body);
    }

    private void warnAuth(HttpServletRequest req, String msg) {
        var logger = cfg.realm.logger();
        if (logger != null && logger.isLoggable(Level.WARNING)) {
            logger.log(Level.WARNING, "realmid: middleware auth fail path={0} reason={1}",
                    req.getRequestURI(), msg);
        }
    }

    static byte[] toBytes(String s) {
        return s == null ? new byte[0] : s.getBytes(StandardCharsets.UTF_8);
    }

    /** Force-pull Logging so the import isn't dead in some builds. */
    @SuppressWarnings("unused")
    private static final Object KEEP_LOGGING_REF = Logging.NOOP;
}
