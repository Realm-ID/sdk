package dev.realmid.sdk.auth;

/**
 * ADR-102 D3 — resolves the PARTNER's own role names for a principal in one org.
 *
 * <p>{@code scope} (ADR-097) carries granted AUTHORITY; {@code product_roles}
 * carries the NAME of the role the bearer holds in YOUR system, for display
 * ("Signed in as: Dispatch"), routing, report defaults and your own audit trail.
 *
 * <p><b>⚠️ Do NOT branch AUTHORIZATION on it.</b> A name is a label, a scope is
 * a grant. Keying authorization off the name re-creates exactly the coupling
 * ADR-101 spent four migrations removing. Both claims ride the same token and
 * answer different questions.
 *
 * <p><b>⚠️ SIDE-EFFECT FREEDOM IS A CONTRACT, NOT A SUGGESTION.</b> The SDK
 * calls this an UNSPECIFIED NUMBER OF TIMES per mint — it retries on error
 * (D11) — so the handler MUST NOT write, bill, audit, or emit. A partner who
 * logs "role resolved" inside it will see triple entries and be right to call it
 * a bug. Retrying is only legal because this is specified as a pure read.
 *
 * <p>It runs on EVERY mint, refresh included, and nothing caches. That freshness
 * is the entire advantage this claim has over {@code customClaims}, which
 * snapshots a value onto a long-lived session.
 *
 * <p>Returning an empty list or null mints NO claim, not {@code []}. Absent and
 * empty must mean the same thing: every token issued before ADR-102 has no claim
 * at all, so a reader has to handle absence regardless.
 */
@FunctionalInterface
public interface ProductRolesHandler {
    java.util.List<String> resolve(String tenantId, String userId) throws Exception;
}
