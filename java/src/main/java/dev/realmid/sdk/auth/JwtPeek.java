package dev.realmid.sdk.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Decodes a JWT payload WITHOUT verifying the signature, to read the subject.
 *
 * <p>Every other peek in this SDK is a private method on the class that needs
 * it ({@code TokensClient} reads jti+exp, {@code PlatformTokenManager} reads
 * iss). None of them was reachable from here, so this is the third — no JWT
 * library, just Jackson, which is already an {@code api} dependency.
 *
 * <p><b>⚠️ Never use this to authorize anything.</b> Signature verification is
 * {@code Verifier}'s job and stays there. The one legitimate use is reading a
 * field out of a token THE ISSUER JUST SIGNED AND HANDED BACK on the same
 * connection — see {@link AuthClient#enrichRefreshMint}.
 */
final class JwtPeek {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private JwtPeek() {}

    /** The {@code jti} and {@code exp} of a JWT, for the ADR-041 revocation
     *  push. {@code jti} is null and {@code exp} is null when unreadable. */
    record RevokeFields(String jti, java.time.Instant exp) {}

    /** Decodes {@code jti} + {@code exp} without verifying the signature. Used
     *  ONLY to push a jti the caller already holds into the revocation cache;
     *  authorization is never decided from this. */
    static RevokeFields revokeFields(String jwt) {
        if (jwt == null) return new RevokeFields(null, null);
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return new RevokeFields(null, null);
        try {
            byte[] raw = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode payload = MAPPER.readTree(new String(raw, StandardCharsets.UTF_8));
            if (payload == null) return new RevokeFields(null, null);
            JsonNode j = payload.get("jti");
            JsonNode e = payload.get("exp");
            String jti = j != null && j.isTextual() && !j.asText().isEmpty() ? j.asText() : null;
            java.time.Instant exp = e != null && e.isNumber() && e.asLong() > 0
                    ? java.time.Instant.ofEpochSecond(e.asLong()) : null;
            return new RevokeFields(jti, exp);
        } catch (RuntimeException | java.io.IOException ex) {
            return new RevokeFields(null, null);
        }
    }

    /** The {@code sub} claim, or {@code null} when the token is not a decodable
     *  JWT or carries no textual subject. */
    static String subject(String jwt) {
        if (jwt == null) return null;
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return null;
        try {
            byte[] raw = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode payload = MAPPER.readTree(new String(raw, StandardCharsets.UTF_8));
            JsonNode sub = payload == null ? null : payload.get("sub");
            return sub != null && sub.isTextual() && !sub.asText().isEmpty() ? sub.asText() : null;
        } catch (RuntimeException | java.io.IOException e) {
            return null;
        }
    }

    /** The {@code sub}/{@code email}/{@code name} claims, mirroring Go's
     *  {@code peekJWTUserFields}. Every field is {@code null} when the token
     *  is not a decodable JWT or the claim is absent/non-textual — used by
     *  {@link AuthClient#enrichRefreshMint} to source
     *  {@link IdentityResolvedEvent}'s best-effort fields on the refresh lane,
     *  where no wire response carries a user object at all. */
    record UserFields(String sub, String email, String name) {}

    static UserFields userFields(String jwt) {
        if (jwt == null) return new UserFields(null, null, null);
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) return new UserFields(null, null, null);
        try {
            byte[] raw = Base64.getUrlDecoder().decode(parts[1]);
            JsonNode payload = MAPPER.readTree(new String(raw, StandardCharsets.UTF_8));
            if (payload == null) return new UserFields(null, null, null);
            return new UserFields(textOrNull(payload, "sub"), textOrNull(payload, "email"),
                    textOrNull(payload, "name"));
        } catch (RuntimeException | java.io.IOException e) {
            return new UserFields(null, null, null);
        }
    }

    private static String textOrNull(JsonNode payload, String field) {
        JsonNode v = payload.get(field);
        return v != null && v.isTextual() && !v.asText().isEmpty() ? v.asText() : null;
    }
}
