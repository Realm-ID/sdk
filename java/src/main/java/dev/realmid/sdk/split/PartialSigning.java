package dev.realmid.sdk.split;

/** The {@code signing} object of a {@code /auth/token/partial} answer (SPEC 14.2). */
public record PartialSigning(String kid, String header, String payload, String partialRi) {}
