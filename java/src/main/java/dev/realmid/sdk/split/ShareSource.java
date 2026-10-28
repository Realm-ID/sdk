package dev.realmid.sdk.split;

/** Where the bundle is loaded from (SPEC 14.5). STUB (S3 red); S7 owns. */
public interface ShareSource {

    /** A loaded bundle and the opaque version of what was read. */
    record Loaded(ShareBundle bundle, String version) {}

    Loaded load();
}
