package dev.realmid.sdk.scope;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;

/**
 * SPEC §11.5.1 — writes the response for a scope denial. The filter has already
 * called {@code onDenied} and set the status to 403; this owns headers and body.
 * It runs on every denial (matched rule not satisfied, default deny, null
 * policy) and never on an allowed request.
 */
@FunctionalInterface
public interface ScopeDeniedWriter {
    void write(HttpServletRequest req, HttpServletResponse res, ScopeDecision decision) throws IOException;
}
