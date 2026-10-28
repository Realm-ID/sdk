package dev.realmid.sdk.split;

/** Options for {@code SigningKeysClient.rotateSplit}; {@code recovery} keeps no previous key (SPEC 14.4). */
public record RotateSplitOptions(String kid, boolean recovery) {}
