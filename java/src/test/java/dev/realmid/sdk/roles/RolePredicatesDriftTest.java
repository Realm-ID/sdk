package dev.realmid.sdk.roles;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DRIFT GATE — {@link RolePredicates} is a hand-written copy of rules the
 * issuer owns, and a hand-maintained copy with nothing checking it is the exact
 * failure mode this file exists to prevent.
 *
 * <p>It reads the AUTHORITATIVE Go source and compares:
 *
 * <ul>
 *   <li>{@code internal/realmrole/assignable.go} — {@code HumanOnlyPermissions}
 *   <li>{@code internal/realmrole/permissions.go} — the {@code action != "read"}
 *       derivation behind {@code ConfersAuthority}
 *   <li>{@code internal/httpapi/role_assignable.go} — the ADR-091
 *       {@code is_system} exemption, and the ADR-101 ABSENCE of a per-role MFA
 *       floor
 * </ul>
 *
 * <p><b>It refuses to swallow unparseable input.</b> If a source file is present
 * but the expected block cannot be found, that is a FAILURE, not a pass: a gate
 * whose extraction silently stops matching reports "nothing to compare, all
 * fine" forever.
 *
 * <p><b>Where the issuer tree must be.</b> {@code Realm-ID/issuer} is a separate
 * (private) repo, so this can only run where a checkout is on disk — the
 * workspace layout puts it at {@code ../../issuer} from this module. Point it
 * elsewhere with {@code -Drealmid.issuerDir=…} or {@code REALMID_ISSUER_DIR}.
 * Absent a checkout the test ABORTS with that instruction rather than passing;
 * wiring a checkout into this repo's CI is filed in {@code ../TODO.md}.
 */
class RolePredicatesDriftTest {

    private static Path issuerDir() {
        String explicit = System.getProperty("realmid.issuerDir");
        if (explicit == null || explicit.isBlank()) {
            explicit = System.getenv("REALMID_ISSUER_DIR");
        }
        if (explicit != null && !explicit.isBlank()) {
            Path p = Paths.get(explicit);
            if (!Files.isDirectory(p.resolve("internal/realmrole"))) {
                throw new IllegalStateException(
                        "issuer dir " + p.toAbsolutePath() + " has no internal/realmrole");
            }
            return p;
        }
        for (String candidate : new String[] {"../../issuer", "../issuer"}) {
            Path p = Paths.get(candidate);
            if (Files.isDirectory(p.resolve("internal/realmrole"))) {
                return p;
            }
        }
        return null;
    }

    private static String read(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read authoritative source " + p, e);
        }
    }

    /** {@code PermFoo = "resource:action"} → constant name to wire string. */
    private static Map<String, String> permConstants(String permissionsGo) {
        Matcher m = Pattern.compile("(?m)^\\s*(Perm[A-Za-z0-9_]+)\\s*=\\s*\"([^\"]+)\"")
                .matcher(permissionsGo);
        Map<String, String> out = new LinkedHashMap<>();
        while (m.find()) {
            out.put(m.group(1), m.group(2));
        }
        if (out.isEmpty()) {
            throw new IllegalStateException(
                    "parsed ZERO Perm* constants out of permissions.go — the extraction "
                            + "stopped matching; fix this test before trusting it");
        }
        return out;
    }

    private static String block(String src, String startMarker, String file) {
        int start = src.indexOf(startMarker);
        if (start < 0) {
            throw new IllegalStateException(
                    "marker \"" + startMarker + "\" not found in " + file
                            + " — the issuer moved or renamed it; this gate cannot report a "
                            + "verdict until it is re-pointed");
        }
        int end = src.indexOf("\n}", start);
        if (end < 0) {
            throw new IllegalStateException("unterminated block after \"" + startMarker + "\" in " + file);
        }
        return src.substring(start, end);
    }

    @Test
    void humanOnlyPermissionsMatchTheIssuer() {
        Path issuer = issuerDir();
        Assumptions.assumeTrue(issuer != null, () -> "no Realm-ID/issuer checkout found at "
                + "../../issuer or ../issuer — set -Drealmid.issuerDir=<path> or "
                + "REALMID_ISSUER_DIR to run the role-predicate drift gate");

        Map<String, String> perms = permConstants(read(issuer.resolve("internal/realmrole/permissions.go")));
        String assignable = read(issuer.resolve("internal/realmrole/assignable.go"));
        String floor = block(assignable,
                "var HumanOnlyPermissions = map[string]struct{}{", "assignable.go");

        Matcher m = Pattern.compile("(?m)^\\s*(Perm[A-Za-z0-9_]+)\\s*:\\s*\\{\\}").matcher(floor);
        Set<String> issuerFloor = new LinkedHashSet<>();
        while (m.find()) {
            String name = m.group(1);
            String wire = perms.get(name);
            if (wire == null) {
                throw new IllegalStateException(
                        "HumanOnlyPermissions names " + name + ", which is not a Perm* constant "
                                + "in permissions.go");
            }
            issuerFloor.add(wire);
        }
        if (issuerFloor.isEmpty()) {
            throw new IllegalStateException(
                    "parsed ZERO entries out of HumanOnlyPermissions — extraction stopped matching");
        }

        if (!issuerFloor.equals(RolePredicates.HUMAN_ONLY_PERMISSIONS)) {
            throw new AssertionError("ADR-081 §2.3 human-only floor has DRIFTED. issuer="
                    + issuerFloor + " sdk/java=" + RolePredicates.HUMAN_ONLY_PERMISSIONS
                    + " — the ISSUER WINS; update RolePredicates.HUMAN_ONLY_PERMISSIONS.");
        }
    }

    /**
     * {@code SYSTEM_UNASSIGNABLE} mirrors {@code realmrole.NonAssignableRoles}
     * — the roles no assignment path accepts whatever their permissions say.
     * The issuer refuses these on the endpoints rather than inside its
     * assignability predicate, which is precisely why a client copy exists and
     * precisely why it needs watching.
     */
    @Test
    void systemUnassignableRolesMatchTheIssuer() {
        Path issuer = issuerDir();
        Assumptions.assumeTrue(issuer != null, () -> "no Realm-ID/issuer checkout found — "
                + "set -Drealmid.issuerDir=<path> or REALMID_ISSUER_DIR");

        String block = block(read(issuer.resolve("internal/realmrole/store.go")),
                "var NonAssignableRoles = map[string]bool{", "store.go");
        Matcher m = Pattern.compile("\"([a-z_]+)\"\\s*:\\s*true").matcher(block);
        Set<String> issuerSet = new LinkedHashSet<>();
        while (m.find()) {
            issuerSet.add(m.group(1));
        }
        if (issuerSet.isEmpty()) {
            throw new IllegalStateException(
                    "parsed ZERO entries out of NonAssignableRoles — extraction stopped matching");
        }
        if (!issuerSet.equals(RolePredicates.SYSTEM_UNASSIGNABLE)) {
            throw new AssertionError("the non-assignable role set has DRIFTED. issuer="
                    + issuerSet + " sdk/java=" + RolePredicates.SYSTEM_UNASSIGNABLE
                    + " — the ISSUER WINS; update RolePredicates.SYSTEM_UNASSIGNABLE.");
        }
    }

    /**
     * {@code ConfersAuthority} is "any grant whose ACTION is not read", derived
     * from the catalog rather than hand-listed. If the issuer ever changes that
     * derivation, this SDK's string-parsing port is wrong.
     */
    @Test
    void authorityIsStillDerivedFromANonReadAction() {
        Path issuer = issuerDir();
        Assumptions.assumeTrue(issuer != null, () -> "no Realm-ID/issuer checkout found — "
                + "set -Drealmid.issuerDir=<path> or REALMID_ISSUER_DIR");

        String permissions = read(issuer.resolve("internal/realmrole/permissions.go"));
        String mutating = block(permissions,
                "var mutatingPermissions = func() map[string]bool {", "permissions.go");
        if (!mutating.contains("p.Action != \"read\"")) {
            throw new AssertionError(
                    "the issuer no longer derives `mutating` from `Action != \"read\"` — "
                            + "RolePredicates.confersAuthority parses for exactly that rule");
        }
        if (!permissions.contains("func ConfersAuthority(perms []string) bool")) {
            throw new AssertionError("realmrole.ConfersAuthority is gone or changed signature");
        }
    }

    /**
     * Two properties of the ADR-081 enforcement predicate the SDK copy mirrors:
     * system roles are EXEMPT from the human-only floor (ADR-091), and ADR-101
     * left no per-role MFA floor to evaluate at all.
     */
    @Test
    void assignabilityEnforcementStillMatches() {
        Path issuer = issuerDir();
        Assumptions.assumeTrue(issuer != null, () -> "no Realm-ID/issuer checkout found — "
                + "set -Drealmid.issuerDir=<path> or REALMID_ISSUER_DIR");

        String gate = block(read(issuer.resolve("internal/httpapi/role_assignable.go")),
                "func requireRoleAssignableToKind(", "role_assignable.go");
        if (!gate.contains("if r.IsSystem {")) {
            throw new AssertionError(
                    "the ADR-091 is_system exemption is gone from requireRoleAssignableToKind — "
                            + "RolePredicates.isRoleAssignableTo still applies it");
        }
        if (gate.contains("FirstUnsatisfiableMFAMethod")) {
            throw new AssertionError(
                    "the issuer evaluates a per-role MFA floor again — ADR-101 removed "
                            + "required_mfa_methods from the wire and RolePredicates has no such check");
        }
    }
}
