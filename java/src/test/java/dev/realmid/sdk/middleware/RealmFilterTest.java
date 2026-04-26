package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.FakeServer;
import dev.realmid.sdk.Realm;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RealmFilterTest {

    private static final String REALM_ID = "01HREALM";
    private static final String AUDIENCE = "acme.test";
    private static final ObjectMapper M = new ObjectMapper();

    private FakeServer api;
    private HttpServer jwksServer;
    private String jwksBase;
    private Realm realm;
    private KeyPair keyPair;
    private final String kid = "kid-1";

    @BeforeEach
    void setUp() throws Exception {
        // RSA keys for signing test access tokens.
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        keyPair = gen.generateKeyPair();

        api = new FakeServer();
        api.on("POST /auth/platform-token", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("platform_token", "pt", "expires_in", 300)));

        // Same server: serve JWKS at /<realm>/.well-known/jwks.json from a separate handler.
        jwksServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        Map<String, Object> jwk = jwkFor((RSAPublicKey) keyPair.getPublic(), kid);
        Map<String, Object> doc = Map.of("keys", List.of(jwk));
        byte[] body = M.writeValueAsBytes(doc);
        jwksServer.createContext("/" + REALM_ID + "/.well-known/jwks.json", exchange -> {
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        jwksServer.start();
        jwksBase = "http://127.0.0.1:" + jwksServer.getAddress().getPort();

        realm = Realm.builder()
                .realmId(REALM_ID)
                .apiKey("rk")
                .baseUrl(jwksBase)
                .audience(AUDIENCE)
                .build();
    }

    @AfterEach
    void tearDown() {
        api.close();
        jwksServer.stop(0);
    }

    @Test
    void exemptPathPassesThrough() throws Exception {
        RealmFilter f = realm.middleware().exemptPaths(List.of("/health")).buildFilter();
        FakeReq req = new FakeReq("GET", "/health");
        FakeRes res = new FakeRes();
        AtomicBoolean ran = new AtomicBoolean(false);
        FilterChain chain = (rq, rs) -> ran.set(true);
        f.doFilter(req, res, chain);
        assertTrue(ran.get());
        assertEquals(0, res.status); // chain didn't set anything
    }

    @Test
    void unauthenticatedReturns401() throws Exception {
        RealmFilter f = realm.middleware().buildFilter();
        FakeReq req = new FakeReq("GET", "/secure");
        FakeRes res = new FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError("chain should not run"); });
        assertEquals(401, res.status);
        Map<?,?> body = M.readValue(res.bytes(), Map.class);
        assertEquals("unauthorized", ((Map<?,?>) body.get("error")).get("code"));
    }

    @Test
    void validBearerAttachesClaims() throws Exception {
        RealmFilter f = realm.middleware().buildFilter();
        String token = signToken(baseClaims(), kid);
        FakeReq req = new FakeReq("GET", "/secure");
        req.headers.put("Authorization", List.of("Bearer " + token));
        FakeRes res = new FakeRes();
        AtomicBoolean ran = new AtomicBoolean(false);
        f.doFilter(req, res, (rq, rs) -> {
            ran.set(true);
            assertNotNull(rq.getAttribute(RealmFilter.CLAIMS_ATTR));
            assertTrue(rq.getAttribute(RealmFilter.CLAIMS_ATTR) instanceof Claims);
        });
        assertTrue(ran.get());
    }

    @Test
    void loginRouteHandled() throws Exception {
        api.on("POST /auth/login", (ex, body) -> FakeServer.Reply.json(200, Map.of(
                "access_token", "at-1",
                "refresh_token", "rt-secret",
                "expires_in", 600,
                "user", Map.of("id", "u1"),
                "tenants", List.of())));
        Realm r2 = Realm.builder().realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl).audience(AUDIENCE).build();
        RealmFilter f = r2.middleware().buildFilter();
        FakeReq req = new FakeReq("POST", "/login");
        req.body = "{\"method\":\"firebase\",\"provider_token\":\"x\"}".getBytes(StandardCharsets.UTF_8);
        FakeRes res = new FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError(); });
        assertEquals(200, res.status);
        Map<?, ?> resp = M.readValue(res.bytes(), Map.class);
        assertEquals("at-1", resp.get("access_token"));
        // Refresh delivered via cookie
        boolean hasCookie = false;
        for (String h : res.headers.getOrDefault("Set-Cookie", List.of())) {
            if (h.contains("realmid_refresh=rt-secret")) hasCookie = true;
        }
        assertTrue(hasCookie);
    }

    @Test
    void mfaProtectedReturns412() throws Exception {
        // Mock the mfa challenge mint endpoint
        api.on("POST /auth/platform-token", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("platform_token", "pt", "expires_in", 300)));
        api.on("POST /auth/mfa/challenge", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("mfa_challenge_token", "ch-mfa", "methods", List.of("totp"))));
        // jwks for the api server
        Map<String, Object> jwk = jwkFor((RSAPublicKey) keyPair.getPublic(), kid);
        api.on("GET /" + REALM_ID + "/.well-known/jwks.json", (ex, body) -> FakeServer.Reply.json(200,
                Map.of("keys", List.of(jwk))));

        Realm r2 = Realm.builder().realmId(REALM_ID).apiKey("rk").baseUrl(api.baseUrl).audience(AUDIENCE).build();
        RealmFilter f = r2.middleware().mfaProtectedPaths(List.of("/admin/*")).buildFilter();
        String token = signToken(baseClaims(), kid);
        FakeReq req = new FakeReq("GET", "/admin/things");
        req.headers.put("Authorization", List.of("Bearer " + token));
        FakeRes res = new FakeRes();
        f.doFilter(req, res, (rq, rs) -> { throw new AssertionError(); });
        assertEquals(412, res.status);
        Map<?, ?> resp = M.readValue(res.bytes(), Map.class);
        assertEquals("mfa_required", ((Map<?, ?>) resp.get("error")).get("code"));
        assertEquals("ch-mfa", resp.get("mfa_challenge_token"));
    }

    // ----- helpers / fakes -----

    private Map<String, Object> baseClaims() {
        long now = Instant.now().getEpochSecond();
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("iss", jwksBase + "/" + REALM_ID);
        c.put("sub", "u1");
        c.put("aud", AUDIENCE);
        c.put("iat", now);
        c.put("exp", now + 600);
        return c;
    }

    private String signToken(Map<String, Object> claims, String useKid) throws Exception {
        // For mfa test we need iss to point at api.baseUrl; allow override.
        if (api != null && api.baseUrl != null && claims.get("iss") != null
                && claims.get("iss").toString().contains(jwksBase) == false) {
            // no-op; just keep static
        }
        Map<String, Object> hdr = new LinkedHashMap<>();
        hdr.put("alg", "RS256");
        hdr.put("typ", "JWT");
        hdr.put("kid", useKid);
        // If iss host matches api baseUrl, use that; otherwise use jwksBase.
        if (claims.get("iss") instanceof String s && s.startsWith("http://127.0.0.1:")
                && api.baseUrl != null && !s.startsWith(api.baseUrl)
                && api.handlers.containsKey("GET /" + REALM_ID + "/.well-known/jwks.json")) {
            // The mfa test re-creates a realm against api.baseUrl; we need to set iss accordingly.
            claims.put("iss", api.baseUrl + "/" + REALM_ID);
        }
        String hb = b64url(M.writeValueAsBytes(hdr));
        String cb = b64url(M.writeValueAsBytes(claims));
        String signing = hb + "." + cb;
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign((RSAPrivateKey) keyPair.getPrivate());
        sig.update(signing.getBytes());
        return signing + "." + b64url(sig.sign());
    }

    private static String b64url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static Map<String, Object> jwkFor(RSAPublicKey pub, String kid) {
        Map<String, Object> jwk = new HashMap<>();
        jwk.put("kty", "RSA");
        jwk.put("kid", kid);
        jwk.put("alg", "RS256");
        jwk.put("use", "sig");
        jwk.put("n", b64url(toUnsigned(pub.getModulus())));
        jwk.put("e", b64url(toUnsigned(pub.getPublicExponent())));
        return jwk;
    }

    static byte[] toUnsigned(BigInteger v) {
        byte[] raw = v.toByteArray();
        if (raw[0] == 0 && raw.length > 1) {
            byte[] t = new byte[raw.length - 1];
            System.arraycopy(raw, 1, t, 0, t.length);
            return t;
        }
        return raw;
    }

    /** Minimal HttpServletRequest fake that the filter actually exercises. */
    static final class FakeReq implements HttpServletRequest {
        final String method;
        final String uri;
        final Map<String, List<String>> headers = new LinkedHashMap<>();
        final Map<String, Object> attrs = new HashMap<>();
        byte[] body = new byte[0];

        FakeReq(String method, String uri) {
            this.method = method;
            this.uri = uri;
        }

        @Override public String getMethod() { return method; }
        @Override public String getRequestURI() { return uri; }
        @Override public String getHeader(String name) {
            for (var e : headers.entrySet()) {
                if (e.getKey().equalsIgnoreCase(name) && !e.getValue().isEmpty()) return e.getValue().get(0);
            }
            return null;
        }
        @Override public java.util.Enumeration<String> getHeaderNames() {
            return Collections.enumeration(headers.keySet());
        }
        @Override public java.util.Enumeration<String> getHeaders(String name) {
            for (var e : headers.entrySet()) {
                if (e.getKey().equalsIgnoreCase(name)) return Collections.enumeration(e.getValue());
            }
            return Collections.emptyEnumeration();
        }
        @Override public Cookie[] getCookies() {
            String c = getHeader("Cookie");
            if (c == null) return null;
            List<Cookie> out = new ArrayList<>();
            for (String pair : c.split(";")) {
                String p = pair.trim();
                int eq = p.indexOf('=');
                if (eq > 0) out.add(new Cookie(p.substring(0, eq), p.substring(eq + 1)));
            }
            return out.toArray(new Cookie[0]);
        }
        @Override public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(new ByteArrayInputStream(body), StandardCharsets.UTF_8));
        }
        @Override public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public int read() { return in.read(); }
                @Override public boolean isFinished() { return in.available() == 0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener readListener) {}
            };
        }
        @Override public Object getAttribute(String name) { return attrs.get(name); }
        @Override public void setAttribute(String name, Object o) { attrs.put(name, o); }
        @Override public void removeAttribute(String name) { attrs.remove(name); }
        @Override public java.util.Enumeration<String> getAttributeNames() { return Collections.enumeration(attrs.keySet()); }

        // --- Unused servlet API stubs ---
        @Override public String getAuthType() { return null; }
        @Override public long getDateHeader(String name) { return -1; }
        @Override public int getIntHeader(String name) { return -1; }
        @Override public String getPathInfo() { return null; }
        @Override public String getPathTranslated() { return null; }
        @Override public String getContextPath() { return ""; }
        @Override public String getQueryString() { return null; }
        @Override public String getRemoteUser() { return null; }
        @Override public boolean isUserInRole(String role) { return false; }
        @Override public java.security.Principal getUserPrincipal() { return null; }
        @Override public String getRequestedSessionId() { return null; }
        @Override public StringBuffer getRequestURL() { return new StringBuffer(uri); }
        @Override public String getServletPath() { return uri; }
        @Override public jakarta.servlet.http.HttpSession getSession(boolean create) { return null; }
        @Override public jakarta.servlet.http.HttpSession getSession() { return null; }
        @Override public String changeSessionId() { return null; }
        @Override public boolean isRequestedSessionIdValid() { return false; }
        @Override public boolean isRequestedSessionIdFromCookie() { return false; }
        @Override public boolean isRequestedSessionIdFromURL() { return false; }
        @Override public boolean authenticate(HttpServletResponse response) { return false; }
        @Override public void login(String username, String password) {}
        @Override public void logout() {}
        @Override public java.util.Collection<jakarta.servlet.http.Part> getParts() { return List.of(); }
        @Override public jakarta.servlet.http.Part getPart(String name) { return null; }
        @Override public <T extends jakarta.servlet.http.HttpUpgradeHandler> T upgrade(Class<T> handlerClass) { return null; }
        @Override public String getCharacterEncoding() { return "UTF-8"; }
        @Override public void setCharacterEncoding(String env) {}
        @Override public int getContentLength() { return body.length; }
        @Override public long getContentLengthLong() { return body.length; }
        @Override public String getContentType() { return getHeader("Content-Type"); }
        @Override public String getParameter(String name) { return null; }
        @Override public java.util.Enumeration<String> getParameterNames() { return Collections.emptyEnumeration(); }
        @Override public String[] getParameterValues(String name) { return new String[0]; }
        @Override public Map<String, String[]> getParameterMap() { return Map.of(); }
        @Override public String getProtocol() { return "HTTP/1.1"; }
        @Override public String getScheme() { return "http"; }
        @Override public String getServerName() { return "localhost"; }
        @Override public int getServerPort() { return 80; }
        @Override public String getRemoteAddr() { return "127.0.0.1"; }
        @Override public String getRemoteHost() { return "127.0.0.1"; }
        @Override public java.util.Locale getLocale() { return java.util.Locale.ENGLISH; }
        @Override public java.util.Enumeration<java.util.Locale> getLocales() { return Collections.enumeration(List.of(java.util.Locale.ENGLISH)); }
        @Override public boolean isSecure() { return false; }
        @Override public jakarta.servlet.RequestDispatcher getRequestDispatcher(String path) { return null; }
        @Override public int getRemotePort() { return 0; }
        @Override public String getLocalName() { return "localhost"; }
        @Override public String getLocalAddr() { return "127.0.0.1"; }
        @Override public int getLocalPort() { return 0; }
        @Override public jakarta.servlet.ServletContext getServletContext() { return null; }
        @Override public jakarta.servlet.AsyncContext startAsync() { return null; }
        @Override public jakarta.servlet.AsyncContext startAsync(jakarta.servlet.ServletRequest servletRequest, jakarta.servlet.ServletResponse servletResponse) { return null; }
        @Override public boolean isAsyncStarted() { return false; }
        @Override public boolean isAsyncSupported() { return false; }
        @Override public jakarta.servlet.AsyncContext getAsyncContext() { return null; }
        @Override public jakarta.servlet.DispatcherType getDispatcherType() { return jakarta.servlet.DispatcherType.REQUEST; }
        @Override public String getRequestId() { return ""; }
        @Override public String getProtocolRequestId() { return ""; }
        @Override public jakarta.servlet.ServletConnection getServletConnection() { return null; }
    }

    static final class FakeRes implements HttpServletResponse {
        int status;
        String contentType;
        Map<String, List<String>> headers = new LinkedHashMap<>();
        ByteArrayOutputStream out = new ByteArrayOutputStream();

        byte[] bytes() { return out.toByteArray(); }

        @Override public void setStatus(int sc) { this.status = sc; }
        @Override public int getStatus() { return status; }
        @Override public void setContentType(String type) { this.contentType = type; }
        @Override public String getContentType() { return contentType; }
        @Override public void setContentLength(int len) {}
        @Override public void setContentLengthLong(long len) {}
        @Override public ServletOutputStream getOutputStream() {
            return new ServletOutputStream() {
                @Override public void write(int b) { out.write(b); }
                @Override public boolean isReady() { return true; }
                @Override public void setWriteListener(WriteListener writeListener) {}
            };
        }
        @Override public java.io.PrintWriter getWriter() { return new java.io.PrintWriter(out); }
        @Override public void addCookie(Cookie cookie) {}
        @Override public boolean containsHeader(String name) { return headers.containsKey(name); }
        @Override public String encodeURL(String url) { return url; }
        @Override public String encodeRedirectURL(String url) { return url; }
        @Override public void sendError(int sc, String msg) { setStatus(sc); }
        @Override public void sendError(int sc) { setStatus(sc); }
        @Override public void sendRedirect(String location) {}
        @Override public void setDateHeader(String name, long date) {}
        @Override public void addDateHeader(String name, long date) {}
        @Override public void setHeader(String name, String value) {
            headers.put(name, new ArrayList<>(List.of(value)));
        }
        @Override public void addHeader(String name, String value) {
            headers.computeIfAbsent(name, k -> new ArrayList<>()).add(value);
        }
        @Override public void setIntHeader(String name, int value) {}
        @Override public void addIntHeader(String name, int value) {}
        @Override public String getHeader(String name) {
            List<String> v = headers.get(name);
            return v == null || v.isEmpty() ? null : v.get(0);
        }
        @Override public java.util.Collection<String> getHeaders(String name) {
            return headers.getOrDefault(name, List.of());
        }
        @Override public java.util.Collection<String> getHeaderNames() { return headers.keySet(); }
        @Override public String getCharacterEncoding() { return "UTF-8"; }
        @Override public void setCharacterEncoding(String charset) {}
        @Override public void setBufferSize(int size) {}
        @Override public int getBufferSize() { return 0; }
        @Override public void flushBuffer() {}
        @Override public void resetBuffer() {}
        @Override public boolean isCommitted() { return false; }
        @Override public void reset() {}
        @Override public void setLocale(java.util.Locale loc) {}
        @Override public java.util.Locale getLocale() { return java.util.Locale.ENGLISH; }
    }
}
