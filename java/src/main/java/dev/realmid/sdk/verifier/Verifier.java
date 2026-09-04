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
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * Verifies RealmID-issued JWTs (SPEC §5). Thread-safe. JWKS cached per-realm
 * with 10m TTL; unknown {@code kid} forces a refetch.
 */
public final class Verifier {

    private static final Set<String> RESERVED = Set.of(
            "iss", "sub", "aud", "iat", "nbf", "exp", "jti", "azp", "tenant_id", "role", "mfa_at"
    );

    private final String baseUrl;
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

    public Verifier(String baseUrl, String pinnedAudience,
                    Function<String, String> audienceResolver,
                    HttpClient http, ObjectMapper mapper,
                    Duration cacheTtl, Duration leeway, Clock clock, Logger logger) {
        this(baseUrl, pinnedAudience, audienceResolver, http, mapper, cacheTtl, leeway, clock, logger, null, null);
    }

    /**
     * @param authority optional ADR-107 subject-keyed staleness marker consulted
     *                  after the standard claim checks. {@code null} → no-op;
     *                  the verifier behaves exactly as it did before ADR-107.
     */
    public Verifier(String baseUrl, String pinnedAudience,
                    Function<String, String> audienceResolver,
                    HttpClient http, ObjectMapper mapper,
                    Duration cacheTtl, Duration leeway, Clock clock, Logger logger,
                    dev.realmid.sdk.authority.AuthorityCache authority) {
        this(baseUrl, pinnedAudience, audienceResolver, http, mapper, cacheTtl, leeway, clock, logger,
                authority, null);
    }

    /**
     * @param authority  optional ADR-107 subject-keyed staleness marker
     * @param revocation optional ADR-041 jti denylist consulted before it. Both
     *                   are {@code null} → no-op; the verifier behaves as it did
     *                   before either existed.
     */
    public Verifier(String baseUrl, String pinnedAudience,
                    Function<String, String> audienceResolver,
                    HttpClient http, ObjectMapper mapper,
                    Duration cacheTtl, Duration leeway, Clock clock, Logger logger,
                    dev.realmid.sdk.authority.AuthorityCache authority,
                    dev.realmid.sdk.revocation.RevocationCache revocation) {
        this.authority = authority;
        this.revocation = revocation;
        if (baseUrl == null || baseUrl.isEmpty()) {
            throw new IllegalArgumentException("realmid: baseUrl required");
        }
        if (pinnedAudience == null && audienceResolver == null) {
            throw new IllegalArgumentException("realmid: audience or audienceResolver required");
        }
        this.baseUrl = stripSlash(baseUrl);
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

    private Claims doVerify(String token, String audienceOverride) {
        if (token == null) {
            throw new RealmException(ErrorCode.MALFORMED, "token is null");
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            throw new RealmException(ErrorCode.MALFORMED, "expected 3 dot-separated parts");
        }

        JsonNode header;
        JsonNode payload;
        byte[] signature;
        try {
            header = mapper.readTree(b64urlDecode(parts[0]));
            payload = mapper.readTree(b64urlDecode(parts[1]));
            signature = b64urlDecode(parts[2]);
        } catch (IOException | IllegalArgumentException e) {
            throw new RealmException(ErrorCode.MALFORMED, "could not parse: " + e.getMessage(), e);
        }

        String alg = strOrNull(header, "alg");
        if (!"RS256".equals(alg)) {
            throw new RealmException(ErrorCode.WRONG_ALGORITHM, "unexpected alg: " + alg);
        }
        String kid = strOrNull(header, "kid");
        if (kid == null || kid.isEmpty()) {
            throw new RealmException(ErrorCode.MALFORMED, "kid missing from header");
        }

        String iss = strOrNull(payload, "iss");
        if (iss == null || iss.isEmpty()) {
            throw new RealmException(ErrorCode.MALFORMED, "iss missing");
        }
        String realmId = extractRealmId(iss);

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

        String issuerPrefix = baseUrl + "/";
        if (!iss.startsWith(issuerPrefix)) {
            throw new RealmException(ErrorCode.WRONG_ISSUER, "iss mismatch: " + iss);
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

        // ADR-041: jti denylist. Runs AFTER signature + claim verification so a
        // junk jti never reaches the cache, and BEFORE the ADR-107 authority
        // check because a revoked token needs no further questions asked of it.
        // Opt-in: no cache → no-op. Fails closed on a cache error.
        String jti = strOrNull(payload, "jti");
        if (revocation != null && jti != null && !jti.isEmpty()) {
            boolean revoked;
            try {
                revoked = revocation.isRevoked(jti);
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
                // D9: the same leeway exp/nbf already carry, so the verifier
                // tells ONE skew story rather than inventing a second one here.
                //
                // A token with no `iat` cannot be shown to postdate the marker,
                // so it is refused for as long as one stands. The issuer always
                // mints `iat`; this is the fail-closed branch, not a live path.
                if (iat == 0 || iat + lw < notBefore.getEpochSecond()) {
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
                extra
        );
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

    private PublicKey resolveKey(String realmId, String kid) {
        CachedJwks cached = cache.get(realmId);
        Instant now = Instant.now(clock);
        if (cached != null && cached.keys.containsKey(kid)
                && cached.fetchedAt.plus(cacheTtl).isAfter(now)) {
            if (logger.isLoggable(Level.DEBUG)) {
                logger.log(Level.DEBUG, "realmid: jwks cache hit realmId={0} kid={1}", realmId, kid);
            }
            return cached.keys.get(kid);
        }
        if (logger.isLoggable(Level.DEBUG)) {
            logger.log(Level.DEBUG, "realmid: jwks cache miss realmId={0} kid={1}", realmId, kid);
        }
        Map<String, PublicKey> fresh = fetchJwks(realmId);
        cache.put(realmId, new CachedJwks(fresh, Instant.now(clock)));
        PublicKey k = fresh.get(kid);
        if (k == null) {
            throw new RealmException(ErrorCode.UNKNOWN_KID, "kid " + kid + " not in JWKS");
        }
        return k;
    }

    private Map<String, PublicKey> fetchJwks(String realmId) {
        URI uri = URI.create(baseUrl + "/" + realmId + "/.well-known/jwks.json");
        HttpRequest req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).GET().build();
        HttpResponse<String> resp;
        try {
            resp = http.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + e.getMessage(), e);
        }
        if (resp.statusCode() != 200) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "jwks fetch returned " + resp.statusCode());
        }
        JsonNode doc;
        try {
            doc = mapper.readTree(resp.body());
        } catch (IOException e) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "decode jwks: " + e.getMessage(), e);
        }
        JsonNode keys = doc.get("keys");
        if (keys == null || !keys.isArray()) {
            throw new RealmException(ErrorCode.JWKS_FETCH_FAILED, "jwks missing keys[]");
        }
        Map<String, PublicKey> out = new HashMap<>();
        for (JsonNode jwk : keys) {
            String kty = strOrNull(jwk, "kty");
            if (!"RSA".equals(kty)) continue;
            String kid = strOrNull(jwk, "kid");
            String n = strOrNull(jwk, "n");
            String e = strOrNull(jwk, "e");
            if (kid == null || n == null || e == null) continue;
            try {
                BigInteger modulus = new BigInteger(1, b64urlDecode(n));
                BigInteger exponent = new BigInteger(1, b64urlDecode(e));
                PublicKey pub = KeyFactory.getInstance("RSA")
                        .generatePublic(new RSAPublicKeySpec(modulus, exponent));
                out.put(kid, pub);
            } catch (GeneralSecurityException ex) {
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
