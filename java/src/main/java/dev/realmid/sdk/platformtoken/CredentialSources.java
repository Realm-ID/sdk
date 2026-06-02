package dev.realmid.sdk.platformtoken;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.realmid.sdk.ErrorCode;
import dev.realmid.sdk.RealmException;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;

/**
 * Built-in {@link CredentialSource}s for workload identity federation
 * (ADR-057): a static API key, the GCP metadata server, GitHub Actions OIDC,
 * and a zero-config auto-detect that probes the ambient cloud sources.
 */
public final class CredentialSources {

    /**
     * The global audience the zero-config SDK requests for a workload OIDC
     * token (ADR-057 §7). Must match the issuer's REALMID_FEDERATION_AUDIENCE.
     * The tenant boundary is the binding's match_claims, not this aud.
     */
    public static final String DEFAULT_FEDERATION_AUDIENCE = "https://api.realmid.dev";

    private static final String GCP_METADATA_ID_TOKEN_URL =
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

    private CredentialSources() {}

    /** Static API-key source — today's behavior. */
    public static CredentialSource staticApiKey(String key) {
        return () -> {
            if (key == null || key.isEmpty()) {
                throw new RealmException(ErrorCode.UNAUTHORIZED, "no API key configured for platform login");
            }
            return Credential.ofApiKey(key);
        };
    }

    /** GCP workload identity (Cloud Run / GKE / GCE) via the metadata server. */
    public static CredentialSource googleWorkloadIdentity(String audience, HttpClient http) {
        String aud = audience == null || audience.isEmpty() ? DEFAULT_FEDERATION_AUDIENCE : audience;
        return () -> {
            String url = GCP_METADATA_ID_TOKEN_URL + "?audience="
                    + URLEncoder.encode(aud, StandardCharsets.UTF_8) + "&format=full";
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(5))
                    .header("Metadata-Flavor", "Google")
                    .GET().build();
            String body = getBody(http, req, "gcp metadata");
            String tok = body.trim();
            if (tok.isEmpty()) {
                throw new RealmException(ErrorCode.SERVER_ERROR, "gcp metadata returned empty token");
            }
            return Credential.ofWorkloadToken(tok);
        };
    }

    /**
     * GitHub Actions OIDC. Requires the workflow to grant {@code id-token:
     * write}; GitHub injects the request URL + bearer via the runner
     * environment.
     */
    public static CredentialSource githubActionsOidc(String audience, HttpClient http, ObjectMapper mapper) {
        String aud = audience == null || audience.isEmpty() ? DEFAULT_FEDERATION_AUDIENCE : audience;
        return () -> {
            String reqUrl = System.getenv("ACTIONS_ID_TOKEN_REQUEST_URL");
            String bearer = System.getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
            if (reqUrl == null || reqUrl.isEmpty() || bearer == null || bearer.isEmpty()) {
                throw new RealmException(ErrorCode.UNAUTHORIZED,
                        "not running in GitHub Actions with `id-token: write` (ACTIONS_ID_TOKEN_REQUEST_* unset)");
            }
            String sep = reqUrl.contains("?") ? "&" : "?";
            String url = reqUrl + sep + "audience=" + URLEncoder.encode(aud, StandardCharsets.UTF_8);
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(5))
                    .header("authorization", "Bearer " + bearer)
                    .header("accept", "application/json; api-version=2.0")
                    .GET().build();
            String body = getBody(http, req, "github oidc");
            try {
                JsonNode node = mapper.readTree(body);
                String value = node.path("value").asText("");
                if (value.isEmpty()) {
                    throw new RealmException(ErrorCode.SERVER_ERROR, "github oidc returned no token");
                }
                return Credential.ofWorkloadToken(value);
            } catch (RealmException e) {
                throw e;
            } catch (Exception e) {
                throw new RealmException(ErrorCode.SERVER_ERROR, "github oidc parse: " + e.getMessage(), e);
            }
        };
    }

    /**
     * Zero-config default: probe the ambient sources lazily at fetch time.
     * GitHub Actions is tried first (its presence is an unambiguous,
     * network-free env signal); otherwise GCP's metadata server is attempted.
     * The first source that yields a token wins.
     */
    public static CredentialSource autoDetect(String audience, HttpClient http, ObjectMapper mapper) {
        List<CredentialSource> sources = List.of(
                githubActionsOidc(audience, http, mapper),
                googleWorkloadIdentity(audience, http));
        return () -> {
            RuntimeException last = null;
            for (CredentialSource s : sources) {
                try {
                    return s.fetch();
                } catch (RuntimeException e) {
                    last = e;
                }
            }
            if (last instanceof RealmException re) {
                throw re;
            }
            throw new RealmException(ErrorCode.UNAUTHORIZED, "no ambient workload identity detected");
        };
    }

    private static String getBody(HttpClient http, HttpRequest req, String what) {
        HttpResponse<String> resp;
        try {
            resp = http.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            Thread.currentThread().interrupt();
            throw new RealmException(ErrorCode.SERVER_ERROR, what + " fetch: " + e.getMessage(), e);
        }
        if (resp.statusCode() != 200) {
            throw new RealmException(ErrorCode.SERVER_ERROR, what + " returned HTTP " + resp.statusCode());
        }
        return resp.body() == null ? "" : resp.body();
    }
}
