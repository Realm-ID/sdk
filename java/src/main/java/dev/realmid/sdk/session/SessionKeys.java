package dev.realmid.sdk.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.Claims;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;

/**
 * SPEC §6.7.1 / §6.7.5 — the session key and every store key the SDK builds.
 *
 * <p>{@code sessionKey} is the {@code sid} claim when it is a non-empty string,
 * otherwise the {@code jti} when it is a non-empty string, otherwise none. Until
 * the issuer emits {@code sid}, the {@code jti} IS the session id.
 */
public final class SessionKeys {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String NS = "realmid:v1:";

    private SessionKeys() {}

    /** What an UNVERIFIED peek of a JWT payload yields. Never authorize from it. */
    public record Peek(String sessionKey, String sub, long iat, long exp, String iss) {}

    /** The session key of a verified token, or null. */
    public static String sessionKey(Claims c) {
        if (c == null) return null;
        return sessionKey(c.sessionId(), c.jwtId());
    }

    public static String sessionKey(String sid, String jti) {
        if (sid != null && !sid.isEmpty()) return sid;
        if (jti != null && !jti.isEmpty()) return jti;
        return null;
    }

    /** Decodes the payload without verifying the signature; null when unreadable. */
    public static Peek peek(String jwt) {
        if (jwt == null) return null;
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return null;
        try {
            byte[] raw = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode p = MAPPER.readTree(new String(raw, StandardCharsets.UTF_8));
            if (p == null || !p.isObject()) return null;
            return new Peek(
                    sessionKey(text(p, "sid"), text(p, "jti")),
                    text(p, "sub"),
                    num(p, "iat"),
                    num(p, "exp"),
                    text(p, "iss"));
        } catch (RuntimeException | java.io.IOException e) {
            return null;
        }
    }

    private static String text(JsonNode p, String f) {
        JsonNode v = p.get(f);
        return v != null && v.isTextual() && !v.asText().isEmpty() ? v.asText() : null;
    }

    private static long num(JsonNode p, String f) {
        JsonNode v = p.get(f);
        return v != null && v.isNumber() ? v.asLong() : 0L;
    }

    // ---- store keys (§6.7.5): components escaped, joined with '|' ----

    static String esc(String s) {
        return s.replace("%", "%25").replace("|", "%7C");
    }

    public static String revokedKey(String sessionKey) { return NS + "rev|" + esc(sessionKey); }

    public static String sessionMarkKey(String sessionKey) { return NS + "nb|" + esc(sessionKey); }

    public static String membershipMarkKey(String sessionKey, String sub) {
        return NS + "nb|" + esc(sessionKey) + "|" + esc(sub);
    }

    public static String lockKey(String refreshToken) { return NS + "lock|" + sha256Hex(refreshToken); }

    public static String outcomeKey(String refreshToken) { return NS + "out|" + sha256Hex(refreshToken); }

    public static String sha256Hex(String s) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
