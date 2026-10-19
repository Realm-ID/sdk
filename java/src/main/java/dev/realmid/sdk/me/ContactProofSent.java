package dev.realmid.sdk.me;

/** Answer of {@link MeClient#sendContactProof}: the channel the code went out on ({@code sms} or {@code whatsapp}). */
public record ContactProofSent(String delivered) {}
