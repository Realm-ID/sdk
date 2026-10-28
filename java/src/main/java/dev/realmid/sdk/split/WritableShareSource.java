package dev.realmid.sdk.split;

/** A source rotation can write to; returns the new version. STUB (S3 red); S7 owns. */
public interface WritableShareSource extends ShareSource {
    String store(ShareBundle bundle);
}
