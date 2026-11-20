package dev.realmid.sdk.verifier;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.Logging;
import dev.realmid.sdk.RealmException;

import java.io.IOException;
import java.lang.System.Logger;
import java.lang.System.Logger.Level;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.function.Function;

/**
 * Verifies RealmID-issued JWTs (SPEC §5). Thread-safe. JWKS cached per-realm
 * with 10m TTL; unknown {@code kid} forces a refetch.
 */
public final class Verifier {

    private static final Set<String> RESERVED = Set.of(
            "iss", "sub", "aud", "iat", "nbf", "exp", "jti", "sid", "azp", "tenant_id", "role", "mfa_at"
    );

    private final String baseUrl;
    private final String issuerUrl;
    private final String realmId;
    private final String pinnedAudience;
    private final Function<String, String> audienceResolver;
    private final HttpClient http;
    private final ObjectMapper mapper;
    private final Duration cacheTtl;
    private final Duration leeway;
    private final Clock clock;
    private final Logger logger;
    private final dev.realmid.sdk.authority.AuthorityCache authority;
    private final dev.realmid.sdk.revocation.RevocationCache revocation;

    private final ConcurrentHashMap<String, CachedJwks> cache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> audienceCache = new ConcurrentHashMap<>();

    /**
     * @param issuerUrl SPEC §1: the host the issuer stamps into {@code iss}.
     *                  {@code null}, empty or whitespace → {@code baseUrl}. A
     *                  trailing slash is trimmed. Read only by the iss check;
     *                  every fetch stays on {@code baseUrl}.
     * @param realmId   REQUIRED: the realm this verifier serves. The realm segment of
     *                  {@code iss} must equal it (SPEC §5). {@code null}, empty or
     *                  whitespace throws {@link IllegalArgumentException}; there is no
     *                  realm-less verifier.
     */
    public Verifier(String baseUrl, String pinnedAudience,
                    Function<String, String> audienceResolver,
                    HttpClient http, ObjectMapper mapper,
                    Duration cacheTtl, Duration leeway, Clock clock, Logger logger,
                    dev.realmid.sdk.authority.AuthorityCache authority,
                    dev.realmid.sdk.revocation.RevocationCache revocation,
                    String issuerUrl, String realmId) {
        this.authority = authority;
        this.revocation = revocation;
        if (baseUrl == null || baseUrl.isEmpty()) {
            throw new IllegalArgumentException("realmid: baseUrl required");
        }
        if (pinnedAudience == null && audienceResolver == null) {
            throw new IllegalArgumentException("realmid: audience or audienceResolver required");
        }
        if (realmId == null || realmId.isBlank()) {
            throw new IllegalArgumentException("realmid: realmId required");
        }
        this.realmId = realmId.strip();
        this.baseUrl = stripSlash(baseUrl);
        String iu = issuerUrl == null ? "" : stripSlash(issuerUrl.strip());
        this.issuerUrl = iu.isEmpty() ? this.baseUrl : iu;
        this.pinnedAudience = pinnedAudience;
        this.audienceResolver = audienceResolver;
        this.http = http == null ? HttpClient.newHttpClient() : http;
        this.mapper = mapper == null ? new ObjectMapper() : mapper;
        this.cacheTtl = cacheTtl == null ? Duration.ofMinutes(10) : cacheTtl;
        this.leeway = leeway == null ? Duration.ofSeconds(30) : leeway;
        this.clock = clock == null ? Clock.systemUTC() : clock;
        this.logger = logger == null ? Logging.NOOP : logger;
    }

    public Claims verify(String token) {
        return verify(token, null);
    }

    /**
     * Verify with an optional per-call audience override. Pass {@code null}
     * for {@code audienceOverride} to use the pinned/resolved audience.
     */
    public Claims verify(String token, String audienceOverride) {
        try {
            return doVerify(token, audienceOverride);
        } catch (RealmException e) {
            if (logger.isLoggable(Level.ERROR)) {
                logger.log(Level.ERROR, "realmid: verify failed code={0} message={1}",
                        e.getCode().wire(), e.getMessage());
            }
            throw e;
        }
    }

    /** Every `malformed` verifier error carries 401 (SPEC 3.1); one constructor so no path can omit it. */
    private static RealmException malformed(String message) {
        return new RealmException(ErrorCode.MALFORMED, message, 401, null);
    }

    private static RealmException malformed(String message, Throwable cause) {
        return new RealmException(ErrorCode.MALFORMED, message, 401, null, cause);
    }

    private Claims doVerify(String token, String audienceOverride) {
        if (token == null) {
            throw malformed("token is null");
        }
        String[] parts = token.split("\\.", -1);
        if (parts.length != 3) {
            throw malformed("expected 3 dot-separated parts");
        }

        JsonNode header;
        JsonNode payload;
        byte[] signature;
        try {
            header = mapper.readTree(b64urlDecode(parts[0]));
            payload = mapper.readTree(b64urlDecode(parts[1]));
            signature = b64urlDecode(parts[2]);
        } catch (IOException | IllegalArgumentException e) {
            throw malformed("could not parse: " + e.getMessage(), e);
        }

        // JSON null, an array or a scalar parses without error but is not a header object.
        if (!header.isObject()) {
            throw malformed("header is not a JSON object");
        }
        String alg = strOrNull(header, "alg");
        if (!"RS256".equals(alg)) {
            throw new RealmException(ErrorCode.WRONG_ALGORITHM, "unexpected alg: " + alg);
        }
        // SPEC 5.1.1: only an ACCESS token verifies. Checked before the kid
        // lookup so a wrongly typed token never triggers a JWKS fetch.
        checkTyp(header);
        // SPEC 4.2 SPEC4_2_claim_fold rule 2 (audit e-02): refuse non-ASCII, duplicate and
        // fold-colliding top-level keys, read from the RAW payload (a decoded map hides duplicates).
        try {
            if (!ClaimFold.payloadAcceptable(b64urlDecode(parts[1]))) {
                throw malformed(
                        "payload carries a non-ASCII, duplicate or reserved-fold claim key");
            }
        } catch (IllegalArgumentException e) {
            throw malformed("could not parse: " + e.getMessage(), e);
        }
        String kid = strOrNull(header, "kid");
        if (kid == null || kid.isEmpty()) {
            throw malformed("kid missing from header");
        }

        String iss = strOrNull(payload, "iss");
        if (iss == null || iss.isEmpty()) {
            throw malformed("iss missing");
        }
        String realmId = extractRealmId(iss);
        // SPEC §5: iss must start with ${issuerUrl}/${realmId}. Checked before any
        // key is resolved, so a token naming another realm never triggers a JWKS
        // fetch for that realm. Only the received iss is named.
        if (!iss.startsWith(issuerUrl + "/") || !realmId.equals(this.realmId)) {
            throw new RealmException(ErrorCode.WRONG_ISSUER, "iss mismatch: " + iss);
        }

        PublicKey key = resolveKey(realmId, kid);

        byte[] signedInput = (parts[0] + "." + parts[1]).getBytes();
        try {
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initVerify(key);
            sig.update(signedInput);
            if (!sig.verify(signature)) {
                throw new RealmException(ErrorCode.BAD_SIGNATURE, "signature invalid");
            }
        } catch (GeneralSecurityException e) {
            throw new RealmException(ErrorCode.BAD_SIGNATURE, "signature check failed: " + e.getMessage(), e);
        }

        String aud = strOrNull(payload, "aud");
        String expected = expectedAudience(realmId, audienceOverride);
        if (expected == null || !expected.equals(aud)) {
            throw new RealmException(ErrorCode.WRONG_AUDIENCE, "aud mismatch: " + aud);
        }

        long now = Instant.now(clock).getEpochSecond();
        long lw = leeway.getSeconds();
        long exp = longOrZero(payload, "exp");
        long nbf = longOrZero(payload, "nbf");
        if (exp != 0 && now - lw >= exp) {
            throw new RealmException(ErrorCode.EXPIRED, "token expired");
        }
        if (nbf != 0 && now + lw < nbf) {
            throw new RealmException(ErrorCode.NOT_YET_VALID, "token not yet valid");
        }

        // SPEC 5.1: a blank subject is refused AFTER the cryptography (an
        // expired blank-sub token reports `expired`) and BEFORE both caches, so
        // neither is ever consulted with an empty key.
        checkSub(payload);
        // SPEC 5.1.1: an `events` member (any value, null included) marks a
        // non-access token (ADR-110 Logout Token) or a poisoned custom claim.
        if (payload.has("events")) {
            throw malformed("token carries an events claim");
        }

        // ADR-041: session denylist. Runs AFTER signature + claim verification so
        // a junk key never reaches the cache, and BEFORE the ADR-107 authority
        // check because a revoked token needs no further questions asked of it.
        // Keyed on the SESSION key (sid, else jti; SPEC 6.7.6 R3), so after
        // Issuer B a revoked session denies every token of it, not one.
        // Opt-in: no cache -> no-op. Fails closed on a cache error.
        String jti = strOrNull(payload, "jti");
        String sid = strOrNull(payload, "sid");
        String sessionKey = dev.realmid.sdk.session.SessionKeys.sessionKey(sid, jti);
        if (revocation != null) {
            boolean revoked;
            try {
                // Both keys: a revoked session denies every token of it, a
                // revoked jti denies that token.
                revoked = (sessionKey != null && revocation.isRevoked(sessionKey))
                        || (jti != null && !jti.isEmpty() && !jti.equals(sessionKey) && revocation.isRevoked(jti));
            } catch (RuntimeException e) {
                throw new RealmException(ErrorCode.UNAUTHORIZED, "revocation cache: " + e.getMessage());
            }
            if (revoked) {
                throw new RealmException(ErrorCode.UNAUTHORIZED, "token revoked");
            }
        }

        // ADR-107: subject-keyed authority check, under the same fail-closed
        // posture as the rest of the verifier. Opt-in: no cache → no-op.
        //
        // `iat` is compared, never `exp`: exp moves with the realm's
        // access_ttl_seconds, so a realm that changed its token lifetime would
        // have the comparison silently misjudge which tokens predate the change.
        String sub = strOrNull(payload, "sub");
        if (authority != null && sub != null && !sub.isEmpty()) {
            Instant notBefore;
            try {
                notBefore = authority.staleSince(sub);
            } catch (RuntimeException e) {
                // Fail closed — but as UNAUTHORIZED, deliberately NOT as
                // TOKEN_STALE. Answering token_stale on a cache OUTAGE would
                // tell every client to refresh at once, which is C5's loop with
                // an unrelated dependency as the trigger.
                throw new RealmException(ErrorCode.UNAUTHORIZED, "authority cache: " + e.getMessage());
            }
            if (notBefore != null) {
                long iat = longOrZero(payload, "iat");
                // A plain `iat < notBefore`: the skew allowance is applied once,
                // when the marker is stamped, and not again here.
                //
                // A token with no `iat` cannot be shown to postdate the marker,
                // so it is refused for as long as one stands. The issuer always
                // mints `iat`; this is the fail-closed branch, not a live path.
                if (iat == 0 || iat < notBefore.getEpochSecond()) {
                    // The 401 is set HERE rather than left to a filter's
                    // default, so a partner verifying tokens by hand (no SDK
                    // filter in the path) still gets the status the ADR-107 D10
                    // contract promises.
                    throw new RealmException(ErrorCode.TOKEN_STALE,
                            "token minted before the subject's authority changed", 401, null);
                }
            }
        }

        Map<String, Object> extra = new HashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = payload.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            if (RESERVED.contains(e.getKey())) continue;
            extra.put(e.getKey(), unwrap(e.getValue()));
        }

        return new Claims(
                iss,
                strOrNull(payload, "sub"),
                aud,
                longOrZero(payload, "iat"),
                nbf,
                exp,
                jti,
                strOrNull(payload, "azp"),
                strOrNull(payload, "tenant_id"),
                strOrNull(payload, "role"),
                longOrZero(payload, "mfa_at"),
                sid,
                extra
        );
    }

    private static void checkTyp(JsonNode header) {
        JsonNode t = header.get("typ");
        String shown = t == null ? "<absent>" : (t.isTextual() ? t.asText() : t.toString());
        boolean ok = false;
        if (t != null && t.isTextual()) {
            String lower = asciiLower(t.asText());
            ok = lower.equals("jwt") || lower.equals("at+jwt") || lower.equals("application/at+jwt");
        }
        if (!ok) {
            throw malformed("unexpected token type: " + shown);
        }
    }

    private static String asciiLower(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            sb.append(c >= 'A' && c <= 'Z' ? (char) (c + 32) : c);
        }
        return sb.toString();
    }

    /** Blank = absent, null, non-string, or only U+0020/U+0009-U+000D. No other whitespace. */
    private static void checkSub(JsonNode payload) {
        JsonNode s = payload.get("sub");
        boolean blank = true;
        if (s != null && s.isTextual()) {
            String v = s.asText();
            for (int i = 0; i < v.length(); i++) {
                char c = v.charAt(i);
                if (c != ' ' && !(c >= '\t' && c <= '\r')) { blank = false; break; }
            }
        }
        if (blank) {
            throw malformed("sub missing or blank");
        }
    }

    private String expectedAudience(String realmId, String override) {
        if (override != null && !override.isEmpty()) return override;
        if (pinnedAudience != null && !pinnedAudience.isEmpty()) return pinnedAudience;
        String cached = audienceCache.get(realmId);
        if (cached != null) return cached;
        if (audienceResolver == null) {
            throw new RealmException(ErrorCode.WRONG_AUDIENCE, "no audience configured and no resolver");
        }
        String resolved = audienceResolver.apply(realmId);
        if (resolved == null || resolved.isEmpty()) {
            throw new RealmException(ErrorCode.WRONG_AUDIENCE,
                    "audience auto-discovery failed");
        }
        audienceCache.put(realmId, resolved);
        return resolved;
    }

    /**
     * Split trust (SPEC 14.4): a settable key resolver replaces the JWKS fetch entirely. It receives
     * (realmId, kid) and returns the pinned key or throws a {@link RealmException}; with it set, RI's JWKS is
     * never fetched. Null restores the JWKS path.
     */
    public void setKeyResolver(java.util.function.BiFunction<String, String, PublicKey> r) { this.keyResolver = r; }

    private volatile java.util.function.BiFunction<String, String, PublicKey> keyResolver;

    private PublicKey resolveKey(String realmId, String kid) {
        java.util.function.BiFunction<String, String, PublicKey> hook = keyResolver;
        if (hook != null) return hook.apply(realmId, kid);
        PublicKey hit = cachedKey(realmId, kid);
        if (hit != null) return hit;
        if (logger.isLoggable(Level.DEBUG)) {
            logger.log(Level.DEBUG, "realmid: jwks cache miss realmId={0} kid={1}", realmId, kid);
        }
        if (Thread.currentThread().isInterrupted()) {
            // The caller's own interrupt is returned to it alone: no flight starts, no window.
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: interrupted",
                    new InterruptedException());
        }
        CompletableFuture<Map<String, PublicKey>> flight;
        // Short critical section: it reads and decides, and never spans the HTTP fetch or a wait.
        synchronized (stateLock) {
            hit = cachedKey(realmId, kid);
            if (hit != null) return hit;
            flight = flights.get(realmId);
            if (flight == null) {
                // The window gates only the refetch a kid missing from a still-fresh set triggers:
                // inside it the caller gets the last answer with no new outbound call. A refetch
                // because the set expired, or none was ever fetched, is never refused by it.
                Attempt last = attempts.get(realmId);
                CachedJwks held = cache.get(realmId);
                boolean setFresh = held != null && withinTtl(held);
                if (setFresh && last != null && last.at.plus(UNKNOWN_KID_REFETCH).isAfter(Instant.now(clock))) {
                    if (last.failure != null) throw last.failure;
                    throw new RealmException(ErrorCode.UNKNOWN_KID, "kid " + kid + " not in JWKS");
                }
                flight = startFlight(realmId);
            }
        }
        Map<String, PublicKey> fresh;
        try {
            // Interruptible wait: an interrupted caller returns at once; the fetch carries on for the rest.
            fresh = flight.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: interrupted", e);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RealmException re) throw re;
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + e.getCause(), e.getCause());
        }
        PublicKey k = fresh.get(kid);
        if (k == null) {
            throw new RealmException(ErrorCode.UNKNOWN_KID, "kid " + kid + " not in JWKS");
        }
        return k;
    }

    /**
     * Starts the realm's one shared fetch on its own thread, so no caller's interrupt reaches it.
     * The fetch records its outcome (window start, cached set or failure) once, then completes the
     * flight. Called with {@code stateLock} held; it only registers and spawns.
     */
    private CompletableFuture<Map<String, PublicKey>> startFlight(String realmId) {
        CompletableFuture<Map<String, PublicKey>> f = new CompletableFuture<>();
        flights.put(realmId, f);
        Thread t = new Thread(() -> {
            Map<String, PublicKey> fresh = null;
            RealmException failure = null;
            try {
                fresh = fetchJwks(realmId);
            } catch (RealmException e) {
                failure = e;
            } catch (Throwable e) {
                // Errors too (OOM, linkage): the flight must always end, or every later caller blocks on it.
                failure = new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + e, e);
            } finally {
                RealmException outcome = failure;
                Map<String, PublicKey> keys = fresh;
                if (outcome == null && keys == null) {
                    outcome = new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: aborted");
                }
                try {
                    synchronized (stateLock) {
                        attempts.put(realmId, new Attempt(Instant.now(clock), outcome));
                        if (outcome == null) cache.put(realmId, new CachedJwks(keys, Instant.now(clock)));
                        flights.remove(realmId, f);
                    }
                } finally {
                    if (outcome == null) f.complete(keys);
                    else f.completeExceptionally(outcome);
                }
            }
        }, "realmid-jwks-fetch");
        t.setDaemon(true);
        try {
            t.start();
        } catch (Throwable e) {
            // "unable to create native thread": nothing will ever complete this flight.
            RealmException failure = new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + e, e);
            flights.remove(realmId, f);
            f.completeExceptionally(failure);
            throw failure;
        }
        return f;
    }

    /** Shortest gap between two JWKS fetches that an unknown kid may trigger. */
    private static final Duration UNKNOWN_KID_REFETCH = Duration.ofSeconds(5);

    private final Object stateLock = new Object();

    /** The in-flight JWKS fetch per realm; guarded by {@code stateLock}. */
    private final ConcurrentHashMap<String, CompletableFuture<Map<String, PublicKey>>> flights = new ConcurrentHashMap<>();

    private boolean withinTtl(CachedJwks c) {
        return c.fetchedAt.plus(cacheTtl).isAfter(Instant.now(clock));
    }

    /** The latest JWKS fetch attempt for a realm; {@code failure} is null when it succeeded. */
    private record Attempt(Instant at, RealmException failure) {}

    private final ConcurrentHashMap<String, Attempt> attempts = new ConcurrentHashMap<>();

    private PublicKey cachedKey(String realmId, String kid) {
        CachedJwks cached = cache.get(realmId);
        if (cached != null && withinTtl(cached)) {
            PublicKey k = cached.keys.get(kid);
            if (k != null && logger.isLoggable(Level.DEBUG)) {
                logger.log(Level.DEBUG, "realmid: jwks cache hit realmId={0} kid={1}", realmId, kid);
            }
            return k;
        }
        return null;
    }

    private static final Duration FETCH_BOUND = Duration.ofSeconds(5);

    private Map<String, PublicKey> fetchJwks(String realmId) {
        URI uri = URI.create(baseUrl + "/" + realmId + "/.well-known/jwks.json");
        // HttpRequest.timeout bounds only the wait for headers; a body that stalls after them would hold
        // the shared flight (and every waiter) forever. One deadline covers headers and body.
        HttpRequest req = HttpRequest.newBuilder(uri).timeout(FETCH_BOUND).GET().build();
        CompletableFuture<HttpResponse<String>> call = http.sendAsync(req, HttpResponse.BodyHandlers.ofString());
        HttpResponse<String> resp;
        try {
            resp = call.get(FETCH_BOUND.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            call.cancel(true);
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: timed out after " + FETCH_BOUND, e);
        } catch (ExecutionException e) {
            Throwable c = e.getCause() == null ? e : e.getCause();
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + c.getMessage(), c);
        } catch (InterruptedException e) {
            call.cancel(true);
            Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + e.getMessage(), e);
        }
        if (resp.statusCode() < 200 || resp.statusCode() > 299) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "jwks fetch returned " + resp.statusCode());
        }
        JsonNode doc;
        try {
            doc = mapper.readTree(resp.body());
        } catch (IOException e) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "decode jwks: " + e.getMessage(), e);
        }
        // A top-level value that is not an object (empty body, `[]`, `"x"`, `5`) cannot be a key set; `null` is an absent `keys`.
        if (!doc.isObject() && !doc.isNull()) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "decode jwks: top-level value is not an object");
        }
        JsonNode keys = doc.get("keys");
        if (keys == null || keys.isNull()) return new HashMap<>();
        if (!keys.isArray()) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "decode jwks: keys is not a list");
        }
        Map<String, PublicKey> out = new HashMap<>();
        for (JsonNode jwk : keys) {
            String kty = strOrNull(jwk, "kty");
            if (!"RSA".equals(kty)) continue;
            JsonNode kidNode = jwk.get("kid");
            String kid = kidNode != null && kidNode.isTextual() ? kidNode.asText() : null;
            String n = strOrNull(jwk, "n");
            String e = strOrNull(jwk, "e");
            if (kid == null || kid.isEmpty()) continue;
            // base64url padding is "not decodable" (SPEC §2); the JDK decoder would accept it.
            if (n == null || n.isEmpty() || e == null || e.isEmpty() || n.indexOf('=') >= 0 || e.indexOf('=') >= 0) {
                throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "unusable key material for kid " + kid);
            }
            try {
                BigInteger modulus = new BigInteger(1, b64urlDecode(n));
                BigInteger exponent = new BigInteger(1, b64urlDecode(e));
                PublicKey pub = KeyFactory.getInstance("RSA")
                        .generatePublic(new RSAPublicKeySpec(modulus, exponent));
                out.put(kid, pub);
            } catch (GeneralSecurityException | IllegalArgumentException ex) {
                throw new RealmException(ErrorCode.JWKS_FETCH_FAILED,
                        "decode key " + kid + ": " + ex.getMessage(), ex);
            }
        }
        return out;
    }

    private static byte[] b64urlDecode(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    private static String extractRealmId(String iss) {
        int idx = iss.lastIndexOf('/');
        if (idx < 0 || idx == iss.length() - 1) {
            throw new RealmException(ErrorCode.WRONG_ISSUER, "iss has no realm segment");
        }
        return iss.substring(idx + 1);
    }

    private static String strOrNull(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static long longOrZero(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || !v.isNumber() ? 0L : v.asLong();
    }

    private static Object unwrap(JsonNode v) {
        if (v.isTextual()) return v.asText();
        if (v.isInt() || v.isLong()) return v.asLong();
        if (v.isDouble() || v.isFloat()) return v.asDouble();
        if (v.isBoolean()) return v.asBoolean();
        if (v.isArray()) {
            java.util.List<Object> list = new java.util.ArrayList<>(v.size());
            for (JsonNode item : v) list.add(unwrap(item));
            return list;
        }
        if (v.isObject()) {
            Map<String, Object> m = new HashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = v.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                m.put(e.getKey(), unwrap(e.getValue()));
            }
            return m;
        }
        return null;
    }

    private static String stripSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }

    private record CachedJwks(Map<String, PublicKey> keys, Instant fetchedAt) {
        CachedJwks(Map<String, PublicKey> keys, Instant fetchedAt) {
            this.keys = Map.copyOf(keys);
            this.fetchedAt = fetchedAt;
        }
    }
}
