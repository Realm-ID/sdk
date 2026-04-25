package dev.realmid.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Verifies RealmID-issued JWTs. Configure once, call {@link #verify(String)}
 * per token. Thread-safe.
 *
 * <p>JWKS is fetched per-realm on demand and cached for
 * {@link Config#cacheTtl()}. An unknown {@code kid} forces a refetch (it is
 * the canonical signal that a key has rotated).</p>
 */
public final class Verifier {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> RESERVED_CLAIMS = Set.of(
            "iss", "sub", "aud", "iat", "nbf", "exp", "jti", "azp", "tenant_id", "role"
    );

    private final Config cfg;
    private final ConcurrentHashMap<String, CachedJwks> cache = new ConcurrentHashMap<>();

    public Verifier(Config cfg) {
        this.cfg = cfg;
    }

    /** Convenience static factory mirroring TS {@code createVerifier()}. */
    public static Verifier create(Config cfg) {
        return new Verifier(cfg);
    }

    /**
     * Parse, signature-verify, and claim-check the token.
     *
     * @throws VerifyException with a stable {@link ErrorCode} on any failure.
     */
    public Claims verify(String token) {
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            throw new VerifyException(ErrorCode.MALFORMED, "expected 3 dot-separated parts");
        }

        JsonNode header;
        JsonNode payload;
        byte[] signature;
        try {
            header = JSON.readTree(b64urlDecode(parts[0]));
            payload = JSON.readTree(b64urlDecode(parts[1]));
            signature = b64urlDecode(parts[2]);
        } catch (IOException e) {
            throw new VerifyException(ErrorCode.MALFORMED, "could not parse: " + e.getMessage(), e);
        }

        String alg = stringOrNull(header, "alg");
        if (!"RS256".equals(alg)) {
            throw new VerifyException(ErrorCode.WRONG_ALGORITHM, "unexpected alg: " + alg);
        }
        String kid = stringOrNull(header, "kid");
        if (kid == null || kid.isEmpty()) {
            throw new VerifyException(ErrorCode.MALFORMED, "kid missing from header");
        }

        String iss = stringOrNull(payload, "iss");
        if (iss == null || iss.isEmpty()) {
            throw new VerifyException(ErrorCode.MALFORMED, "iss missing");
        }
        String realmId = extractRealmId(iss);

        PublicKey key = resolveKey(realmId, kid);

        byte[] signedInput = (parts[0] + "." + parts[1]).getBytes();
        try {
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initVerify(key);
            sig.update(signedInput);
            if (!sig.verify(signature)) {
                throw new VerifyException(ErrorCode.BAD_SIGNATURE, "signature invalid");
            }
        } catch (GeneralSecurityException e) {
            throw new VerifyException(ErrorCode.BAD_SIGNATURE, "signature check failed: " + e.getMessage(), e);
        }

        String issuerPrefix = cfg.baseUrl() + "/";
        if (!iss.startsWith(issuerPrefix)) {
            throw new VerifyException(ErrorCode.WRONG_ISSUER, "iss mismatch: " + iss);
        }
        String aud = stringOrNull(payload, "aud");
        if (!cfg.audience().equals(aud)) {
            throw new VerifyException(ErrorCode.WRONG_AUDIENCE, "aud mismatch: " + aud);
        }

        long now = Instant.now(cfg.clock()).getEpochSecond();
        long leeway = cfg.leeway().getSeconds();
        long exp = longOrZero(payload, "exp");
        long nbf = longOrZero(payload, "nbf");
        if (exp != 0 && now - leeway >= exp) {
            throw new VerifyException(ErrorCode.EXPIRED, "token expired");
        }
        if (nbf != 0 && now + leeway < nbf) {
            throw new VerifyException(ErrorCode.NOT_YET_VALID, "token not yet valid");
        }

        Map<String, Object> extra = new HashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = payload.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            if (RESERVED_CLAIMS.contains(e.getKey())) continue;
            extra.put(e.getKey(), unwrap(e.getValue()));
        }

        return new Claims(
                iss,
                stringOrNull(payload, "sub"),
                aud,
                longOrZero(payload, "iat"),
                nbf,
                exp,
                stringOrNull(payload, "jti"),
                stringOrNull(payload, "azp"),
                stringOrNull(payload, "tenant_id"),
                stringOrNull(payload, "role"),
                extra
        );
    }

    private PublicKey resolveKey(String realmId, String kid) {
        CachedJwks cached = cache.get(realmId);
        Instant now = Instant.now(cfg.clock());
        if (cached != null
                && cached.keys.containsKey(kid)
                && cached.fetchedAt.plus(cfg.cacheTtl()).isAfter(now)) {
            return cached.keys.get(kid);
        }

        Map<String, PublicKey> fresh = fetchJwks(realmId);
        cache.put(realmId, new CachedJwks(fresh, Instant.now(cfg.clock())));
        PublicKey k = fresh.get(kid);
        if (k == null) {
            throw new VerifyException(ErrorCode.UNKNOWN_KID, "kid " + kid + " not in JWKS");
        }
        return k;
    }

    private Map<String, PublicKey> fetchJwks(String realmId) {
        URI url = URI.create(cfg.baseUrl() + "/" + realmId + "/.well-known/jwks.json");
        HttpRequest req = HttpRequest.newBuilder(url)
                .timeout(java.time.Duration.ofSeconds(5))
                .GET()
                .build();
        HttpResponse<String> resp;
        try {
            resp = cfg.httpClient().send(req, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new VerifyException(ErrorCode.JWKS_FETCH_FAILED, "fetch jwks: " + e.getMessage(), e);
        }
        if (resp.statusCode() != 200) {
            throw new VerifyException(
                    ErrorCode.JWKS_FETCH_FAILED,
                    "jwks fetch returned " + resp.statusCode()
            );
        }
        JsonNode doc;
        try {
            doc = JSON.readTree(resp.body());
        } catch (IOException e) {
            throw new VerifyException(ErrorCode.JWKS_FETCH_FAILED, "decode jwks: " + e.getMessage(), e);
        }
        JsonNode keys = doc.get("keys");
        if (keys == null || !keys.isArray()) {
            throw new VerifyException(ErrorCode.JWKS_FETCH_FAILED, "jwks missing keys[]");
        }
        Map<String, PublicKey> out = new HashMap<>();
        for (JsonNode jwk : keys) {
            String kty = stringOrNull(jwk, "kty");
            if (!"RSA".equals(kty)) continue;
            String kid = stringOrNull(jwk, "kid");
            String n = stringOrNull(jwk, "n");
            String e = stringOrNull(jwk, "e");
            if (kid == null || n == null || e == null) continue;
            try {
                BigInteger modulus = new BigInteger(1, b64urlDecode(n));
                BigInteger exponent = new BigInteger(1, b64urlDecode(e));
                PublicKey pub = KeyFactory.getInstance("RSA")
                        .generatePublic(new RSAPublicKeySpec(modulus, exponent));
                out.put(kid, pub);
            } catch (GeneralSecurityException ex) {
                throw new VerifyException(
                        ErrorCode.JWKS_FETCH_FAILED,
                        "decode key " + kid + ": " + ex.getMessage(),
                        ex
                );
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
            throw new VerifyException(ErrorCode.WRONG_ISSUER, "iss has no realm segment");
        }
        return iss.substring(idx + 1);
    }

    private static String stringOrNull(JsonNode node, String field) {
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

    private record CachedJwks(Map<String, PublicKey> keys, Instant fetchedAt) {
        CachedJwks(Map<String, PublicKey> keys, Instant fetchedAt) {
            this.keys = Map.copyOf(keys);
            this.fetchedAt = fetchedAt;
        }
    }
}
