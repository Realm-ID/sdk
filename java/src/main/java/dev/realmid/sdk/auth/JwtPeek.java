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
}
