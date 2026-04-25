package dev.realmid.example;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import dev.realmid.sdk.Claims;
import dev.realmid.sdk.Config;
import dev.realmid.sdk.Verifier;
import dev.realmid.sdk.VerifyException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Minimal example: verify a RealmID access token from the command line and
 * print the claims as JSON.
 *
 * Usage:
 *   ./gradlew run --args="<base-url> <audience> <jwt>"
 *
 * Or, equivalently:
 *   java -cp <classpath> dev.realmid.example.VerifyToken \
 *       https://auth.realmid.dev your-partner-audience <jwt>
 */
public final class VerifyToken {
    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            System.err.println("usage: VerifyToken <base-url> <audience> <jwt>");
            System.exit(2);
            return;
        }
        String baseUrl = args[0];
        String audience = args[1];
        String token = args[2];

        Verifier verifier = Verifier.create(
                Config.builder().baseUrl(baseUrl).audience(audience).build()
        );

        Claims claims;
        try {
            claims = verifier.verify(token);
        } catch (VerifyException e) {
            System.err.println("verify failed: " + e.getCode().wire() + " — " + e.getMessage());
            System.exit(1);
            return;
        }

        Map<String, Object> view = new LinkedHashMap<>();
        view.put("iss", claims.issuer());
        view.put("sub", claims.subject());
        view.put("aud", claims.audience());
        view.put("iat", claims.issuedAt());
        if (claims.notBefore() != 0) view.put("nbf", claims.notBefore());
        if (claims.expiry() != 0) view.put("exp", claims.expiry());
        if (claims.jwtId() != null) view.put("jti", claims.jwtId());
        if (claims.authorizedParty() != null) view.put("azp", claims.authorizedParty());
        if (claims.tenantId() != null) view.put("tenant_id", claims.tenantId());
        if (claims.role() != null) view.put("role", claims.role());
        if (!claims.extra().isEmpty()) view.put("extra", claims.extra());

        ObjectMapper json = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
        System.out.println(json.writeValueAsString(view));
    }
}
