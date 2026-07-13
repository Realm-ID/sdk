package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Owner-facing signing-key surface (roles/signing-keys overhaul).
 *
 * <p>A platform owner reads their realm's keyring and self-serve rotates
 * the active signing key:
 * <ul>
 *   <li>{@code GET  /platforms/{id}/signing-keys} — keyring + rotation policy</li>
 *   <li>{@code POST /platforms/{id}/signing-keys/rotate} — mint a new active key</li>
 * </ul>
 *
 * <p>Distinct from the base-staff ops rotate at {@code /admin/platforms/{id}/…}
 * (not part of this partner SDK). Both are realm-admin gated server-side;
 * this client targets the caller's own realm. Rotate shares the server-side
 * rate limiter (a 429 {@code rate_limited} surfaces as a {@code RealmException}).
 */
public final class SigningKeysClient {

    private final HttpTransport http;
    private final String realmId;

    public SigningKeysClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    /** GET /platforms/{id}/signing-keys — keyring (newest-first) + rotation policy. */
    public SigningKeysResponse list() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "GET", "/platforms/" + enc(realmId) + "/signing-keys"));
        return http.mapper().convertValue(raw, SigningKeysResponse.class);
    }

    /** POST /platforms/{id}/signing-keys/rotate — self-serve rotate. */
    public RotateSigningKeyResult rotate() {
        JsonNode raw = http.request(HttpTransport.Request.of(
                "POST", "/platforms/" + enc(realmId) + "/signing-keys/rotate"));
        return http.mapper().convertValue(raw, RotateSigningKeyResult.class);
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
}
