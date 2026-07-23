package dev.realmid.sdk.integrations;

/** Optional pagination inputs for the integration list surfaces. */
public record IntegrationListOpts(String cursor, Integer limit) {

    public static IntegrationListOpts empty() { return new IntegrationListOpts(null, null); }

    public static IntegrationListOpts withCursor(String c) { return new IntegrationListOpts(c, null); }
}
