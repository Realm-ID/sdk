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
            if (GlobMatcher.match(r.path(), path)) return r;
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

    private void handleLogout(HttpServletRequest req, HttpServletResponse res) throws IOException {
        String refresh = readRefresh(req);
        try {
            cfg.realm.auth().logout(LogoutRequest.of(refresh));
        } catch (RealmException ignored) { /* best effort */ }
        if (cfg.tokenDelivery == TokenDelivery.COOKIE) clearRefreshCookie(res);
        sendJson(res, 200, Map.of("status", "ok"));
    }

    private void handleRefresh(HttpServletRequest req, HttpServletResponse res) throws IOException {
        String refresh = readRefresh(req);
        Map<String, Object> body = readJson(req);
        if (cfg.tokenDelivery == TokenDelivery.BODY) {
            Object br = body.get("refresh_token");
            if (br == null) br = body.get("refreshToken");
            if (br instanceof String s && !s.isEmpty()) refresh = s;
        }
        if (refresh == null || refresh.isEmpty()) {
            sendError(res, 401, ErrorCode.UNAUTHORIZED.wire(), "refresh token missing", null);
            return;
        }
        Object tenantId = body.get("tenant_id");
        if (tenantId == null) tenantId = body.get("tenantId");
        if (tenantId == null || String.valueOf(tenantId).isEmpty()) {
            sendError(res, 400, ErrorCode.TENANT_REQUIRED.wire(), "tenant_id required", null);
            return;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> custom = (Map<String, Object>) (body.get("custom_claims") != null
                ? body.get("custom_claims") : body.get("customClaims"));
        try {
            TokenResponse t = cfg.realm.auth().token(new TokenRequest(
                    refresh, String.valueOf(tenantId), custom, null));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", t.accessToken());
            out.put("expires_in", t.expiresIn());
            out.put("tenant_id", t.tenantId());
            out.put("role", t.role());
            deliverRefresh(res, out, t.refreshToken());
            sendJson(res, 200, out);
        } catch (RealmException e) {
            sendError(res, e.getHttpStatus() > 0 ? e.getHttpStatus() : 500,
                    e.getCode().wire(), e.getMessage(), e.getDetails());
        }
    }

    private void handleMfaVerify(HttpServletRequest req, HttpServletResponse res) throws IOException {
        Map<String, Object> body = readJson(req);
        String challenge = String.valueOf(body.getOrDefault("challenge_token",
                body.getOrDefault("challengeToken", "")));
        String code = String.valueOf(body.getOrDefault("code", ""));
        try {
            Session s = cfg.realm.auth().mfaVerify(MFAVerifyRequest.of(challenge, code));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("access_token", s.accessToken());
            out.put("expires_in", s.expiresIn());
            out.put("user", s.user());
            out.put("tenants", s.tenants());
            deliverRefresh(res, out, s.refreshToken());
            sendJson(res, 200, out);
        } catch (RealmException e) {
            sendError(res, e.getHttpStatus() > 0 ? e.getHttpStatus() : 500,
                    e.getCode().wire(), e.getMessage(), e.getDetails());
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
        StringBuilder sb = new StringBuilder();
        sb.append(cfg.cookieName).append('=').append(value);
        sb.append("; HttpOnly; Path=/");
        if (cfg.cookieSameSite != null) sb.append("; SameSite=").append(cfg.cookieSameSite);
        if (cfg.cookieSecure) sb.append("; Secure");
        if (cfg.cookieDomain != null) sb.append("; Domain=").append(cfg.cookieDomain);
        res.addHeader("Set-Cookie", sb.toString());
    }

    private void clearRefreshCookie(HttpServletResponse res) {
        StringBuilder sb = new StringBuilder();
        sb.append(cfg.cookieName).append("=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        if (cfg.cookieSameSite != null) sb.append("; SameSite=").append(cfg.cookieSameSite);
        if (cfg.cookieSecure) sb.append("; Secure");
        if (cfg.cookieDomain != null) sb.append("; Domain=").append(cfg.cookieDomain);
        res.addHeader("Set-Cookie", sb.toString());
    }

    private String readRefresh(HttpServletRequest req) {
        if (cfg.tokenDelivery == TokenDelivery.COOKIE) {
            Cookie[] cookies = req.getCookies();
            if (cookies == null) return null;
            for (Cookie c : cookies) {
                if (cfg.cookieName.equals(c.getName())) return c.getValue();
            }
            return null;
        }
        return null; // body delivery handled in handleRefresh
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
