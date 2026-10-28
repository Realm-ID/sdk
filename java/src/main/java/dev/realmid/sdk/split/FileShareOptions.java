package dev.realmid.sdk.split;

import java.util.Arrays;
import java.util.Objects;

/**
 * File source options (SPEC 14.5, R93): a 32-byte KEK, or {@code localDev} to go without one, and the
 * realm id the sealed envelope is bound to (an AAD INPUT, required with a KEK). The KEK is never printed.
 */
public record FileShareOptions(byte[] kek, boolean localDev, String realm) {

    @Override
    public String toString() {
        return "FileShareOptions{kek=" + (kek == null ? "none" : "[redacted]") + ", localDev=" + localDev
                + ", realm=" + realm + "}";
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof FileShareOptions f && Arrays.equals(kek, f.kek) && localDev == f.localDev
                && Objects.equals(realm, f.realm);
    }

    @Override
    public int hashCode() {
        return 31 * Arrays.hashCode(kek) + Objects.hash(localDev, realm);
    }
}
