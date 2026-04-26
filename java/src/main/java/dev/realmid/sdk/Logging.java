package dev.realmid.sdk;

import java.lang.System.Logger;
import java.lang.System.Logger.Level;
import java.util.ResourceBundle;

/** Logger helpers and a no-op default (SPEC §9). */
public final class Logging {
    private Logging() {}

    public static final Logger NOOP = new NoopLogger();

    /** Truncate a credential to its first 6 chars + ellipsis (SPEC §9). */
    public static String redact(String credential) {
        if (credential == null || credential.isEmpty()) return "<none>";
        if (credential.length() <= 6) return credential + "...";
        return credential.substring(0, 6) + "...";
    }

    static final class NoopLogger implements Logger {
        @Override public String getName() { return "realmid.noop"; }
        @Override public boolean isLoggable(Level level) { return false; }
        @Override public void log(Level level, ResourceBundle bundle, String msg, Throwable thrown) {}
        @Override public void log(Level level, ResourceBundle bundle, String format, Object... params) {}
    }
}
