package dev.realmid.sdk.middleware;

/** How the middleware returns refresh tokens (SPEC §10.2). */
public enum TokenDelivery {
    COOKIE,
    BODY
}
