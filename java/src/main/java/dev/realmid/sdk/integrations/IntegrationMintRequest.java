package dev.realmid.sdk.integrations;

/**
 * Input to {@link IntegrationsClient#mintToken}. {@code apiKey} is the SOURCE
 * platform's raw {@code platform_api} key (never a user/session token).
 * {@code sourceOrgId} is required and stamped into the token + target-org audit,
 * but is caller-asserted (ADR-082 §7.6).
 */
public record IntegrationMintRequest(String apiKey, String installationId, String sourceOrgId) {
}
