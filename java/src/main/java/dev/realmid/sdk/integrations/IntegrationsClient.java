package dev.realmid.sdk.integrations;

import com.fasterxml.jackson.databind.JsonNode;
import dev.realmid.sdk.http.HttpTransport;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Cross-realm integrations surface — {@code realm.integrations()} (ADR-082/083).
 * Mirrors Go's {@code realm.Integrations} / TS's {@code realm.integrations}.
 *
 * <p>A SOURCE platform publishes an integration; a TARGET org installs it,
 * admitting a {@code kind=service} principal into the org that holds a chosen
 * service-typed role; the source platform then MINTS short-lived target-realm
 * access tokens against the installation. GitHub-App-shaped. RI hosts no consent
 * screen — this surface IS the consent surface (ADR-083 §5).
 *
 * <p>The SDK is per-realm: register/mint run on the SOURCE realm's client;
 * install/uninstall run on the TARGET realm's client. Source-side methods take
 * no platform id (baked in, like {@code RolesClient}).
 *
 * <p>Server error codes surface on {@link dev.realmid.sdk.RealmException} via
 * {@link dev.realmid.sdk.ErrorCode}: {@code slug_taken} / {@code already_installed}
 * (409), {@code permissions_required} / {@code unknown_permission} (400),
 * {@code permissions_exceed_grantor} (403),
 * {@code integration_not_found} / {@code installation_not_found} (404),
 * {@code installation_revoked} / {@code role_unavailable} (403),
 * {@code key_class_mismatch} (401). {@code role_not_service_typed} /
 * {@code role_not_installable} are retained in {@link dev.realmid.sdk.ErrorCode}
 * but DEAD — the issuer has emitted neither since ADR-101 D7.
 */
public final class IntegrationsClient {

    private final HttpTransport http;
    private final String realmId;

    public IntegrationsClient(HttpTransport http, String realmId) {
        this.http = http;
        this.realmId = realmId;
    }

    private String sourceBase() {
        return "/platforms/" + enc(realmId) + "/integrations";
    }

    private String targetBase(String tenantId) {
        return "/tenants/" + enc(tenantId) + "/integration-installations";
    }

    // ---- source side ----

    /** POST /platforms/{id}/integrations — publish a new integration. */
    public Integration register(IntegrationCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("slug", body.slug());
        b.put("display_name", body.displayName());
        if (body.description() != null) b.put("description", body.description());
        if (body.homepageUrl() != null) b.put("homepage_url", body.homepageUrl());
        if (body.listed()) b.put("listed", true);
        JsonNode raw = http.request(HttpTransport.Request.of("POST", sourceBase()).body(b));
        return http.mapper().convertValue(raw, Integration.class);
    }

    /** GET /platforms/{id}/integrations — one page of published integrations. */
    public IntegrationListPage list(IntegrationListOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET", sourceBase()).query(q));
        List<Integration> items = new ArrayList<>();
        if (raw != null && raw.has("items") && raw.get("items").isArray()) {
            for (JsonNode n : raw.get("items")) items.add(http.mapper().convertValue(n, Integration.class));
        }
        return new IntegrationListPage(items, nextCursor(raw));
    }

    public IntegrationListPage list() { return list(null); }

    /** PATCH /platforms/{id}/integrations/{iid} — edit display fields / listed. */
    public Integration update(String id, IntegrationPatch patch) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (patch.displayName() != null) b.put("display_name", patch.displayName());
        if (patch.description() != null) b.put("description", patch.description());
        if (patch.homepageUrl() != null) b.put("homepage_url", patch.homepageUrl());
        if (patch.listed() != null) b.put("listed", patch.listed());
        JsonNode raw = http.request(HttpTransport.Request.of("PATCH", sourceBase() + "/" + enc(id)).body(b));
        return http.mapper().convertValue(raw, Integration.class);
    }

    /** POST …/{iid}/disable — reversible halt of every mint. */
    public void disable(String id) {
        http.request(HttpTransport.Request.of("POST", sourceBase() + "/" + enc(id) + "/disable"));
    }

    /** POST …/{iid}/enable — re-enable a disabled integration. */
    public void enable(String id) {
        http.request(HttpTransport.Request.of("POST", sourceBase() + "/" + enc(id) + "/enable"));
    }

    /**
     * DELETE /platforms/{id}/integrations/{iid} — permanent disable (the source
     * half of two-ended revocation). NOT a cascade delete; target orgs' inbound
     * history survives (ADR-083 §9).
     */
    public void remove(String id) {
        http.request(HttpTransport.Request.of("DELETE", sourceBase() + "/" + enc(id)));
    }

    // ---- target side ----

    /**
     * POST /tenants/{id}/integration-installations — admit a foreign
     * integration, granting it exactly the permissions {@code body.permissions()}
     * names (ADR-101 D7).
     */
    public InstallResult install(String tenantId, InstallRequest body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("integration_id", body.integrationId());
        b.put("permissions", body.permissions());
        JsonNode raw = http.request(HttpTransport.Request.of("POST", targetBase(tenantId)).body(b));
        return http.mapper().convertValue(raw, InstallResult.class);
    }

    /**
     * GET /tenants/{id}/integration-installations — the inbound-access list. A
     * non-zero count after an ownership transfer is foreign access the new owner
     * never approved (ADR-082 §7.4) — surface it.
     */
    public InstallationListPage listInstallations(String tenantId, IntegrationListOpts opts) {
        Map<String, Object> q = new LinkedHashMap<>();
        if (opts != null) {
            if (opts.cursor() != null) q.put("cursor", opts.cursor());
            if (opts.limit() != null) q.put("limit", opts.limit());
        }
        JsonNode raw = http.request(HttpTransport.Request.of("GET", targetBase(tenantId)).query(q));
        List<Installation> items = new ArrayList<>();
        if (raw != null && raw.has("items") && raw.get("items").isArray()) {
            for (JsonNode n : raw.get("items")) items.add(http.mapper().convertValue(n, Installation.class));
        }
        return new InstallationListPage(items, nextCursor(raw));
    }

    public InstallationListPage listInstallations(String tenantId) {
        return listInstallations(tenantId, null);
    }

    /**
     * DELETE /tenants/{id}/integration-installations/{iid} — revoke an inbound
     * edge. Future mints fail; live access tokens are NOT revoked (bounded by the
     * 600 s TTL, ADR-083 §4.4).
     */
    public void uninstall(String tenantId, String installationId) {
        http.request(HttpTransport.Request.of("DELETE", targetBase(tenantId) + "/" + enc(installationId)));
    }

    // ---- mint ----

    /**
     * Mint a brokered target-realm access token against an installation,
     * authenticated by the SOURCE platform's raw {@code platform_api} key (NOT a
     * user/session token). Returns an access token only — no refresh — so re-mint
     * as expiry nears. {@code skipPlatformToken(true)} keeps the SDK's own
     * platform bearer off this call: the raw {@code apiKey} in the body IS the
     * credential.
     */
    public IntegrationMintResult mintToken(IntegrationMintRequest req) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("grant_type", "integration_installation");
        b.put("api_key", req.apiKey());
        b.put("installation_id", req.installationId());
        b.put("source_org_id", req.sourceOrgId());
        JsonNode raw = http.request(
                HttpTransport.Request.of("POST", "/auth/login").skipPlatformToken(true).body(b));
        return http.mapper().convertValue(raw, IntegrationMintResult.class);
    }

    private static String nextCursor(JsonNode raw) {
        if (raw != null && raw.hasNonNull("next_cursor") && raw.get("next_cursor").isTextual()) {
            return raw.get("next_cursor").asText();
        }
        return null;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
