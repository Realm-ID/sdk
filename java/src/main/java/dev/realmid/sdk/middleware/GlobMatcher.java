package dev.realmid.sdk.middleware;

import java.util.regex.Pattern;

/**
 * SPEC §10.2 / §11.4.1 glob matcher: {@code *} = within ONE segment (empty
 * included); {@code **} = zero or more segments, and {@code /x/**} matches the
 * bare {@code /x} (v0.63.0, aligned with Go; BREAKING vs v0.62).
 *
 * <p>Two modes share one compiler. {@link #match} treats {@code {} and
 * {@code }} as literal text — that is {@code exemptPaths}, where a placeholder
 * would widen an exemption, the fail-open direction. {@link #matchPlaceholders}
 * additionally reads {@code {name}} as exactly one NON-empty segment
 * ({@code mfaProtectedPaths}, {@code ScopeRule} paths); every other brace form
 * compiles to a pattern that matches NO path (inert, never literal).
 */
public final class GlobMatcher {
    private GlobMatcher() {}

    /** The {@code 400} body for a request path the SDK refuses to decide (SPEC11_4_1_source). */
    public static final String INVALID_PATH_BODY =
            "{\"error\":{\"code\":\"invalid_path\",\"message\":\"request path is not canonical\"}}";

    /**
     * SPEC11_4_1_canon: the ONE matcher for {@code exemptPaths},
     * {@code mfaProtectedPaths} and {@code ScopeRule} paths. One trailing slash is
     * ignored on both sides; literals compare ASCII case-insensitively (by ASCII
     * lowercasing both sides, never a regex flag); nothing else is normalised.
     * {@code kind} is {@code exempt} (braces literal), {@code mfa} or {@code scope}.
     */
    public static boolean canonicalMatch(String pattern, String kind, String path) {
        boolean placeholders = !"exempt".equals(kind);
        if (placeholders && validateBraces(pattern) != null) return false;
        Pattern re = toRegex(asciiLower(foldSlash(pattern)), placeholders);
        return re.matcher(asciiLower(foldSlash(path))).matches();
    }

    /** Literal-brace mode ({@code exemptPaths}); canonical (SPEC11_4_1_canon). */
    public static boolean match(String pattern, String path) {
        return canonicalMatch(pattern, "exempt", path);
    }

    /** Placeholder mode ({@code mfaProtectedPaths}, {@code ScopeRule}); canonical. */
    public static boolean matchPlaceholders(String pattern, String path) {
        return canonicalMatch(pattern, "mfa", path);
    }

    private static String foldSlash(String s) {
        return s.length() > 1 && s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String asciiLower(String s) {
        StringBuilder b = null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 'A' && c <= 'Z') {
                if (b == null) b = new StringBuilder(s);
                b.setCharAt(i, (char) (c + 32));
            }
        }
        return b == null ? s : b.toString();
    }

    /**
     * SPEC11_4_1_source (java): the path the container and Spring MVC route on,
     * {@code getServletPath() + getPathInfo()} (decoded, {@code ;params} removed,
     * context path excluded). Returns {@code null} when the request must be
     * refused with {@code 400 invalid_path}: the RAW request URI holds
     * {@code %2F}, {@code %5C}, {@code %25} or {@code %2E} (hex case-insensitive),
     * or a dot segment ({@code .} or {@code ..}, judged after the segment's
     * {@code ;params} are removed, so {@code ..;} counts).
     */
    public static String requestPath(jakarta.servlet.http.HttpServletRequest req) {
        String raw = req.getRequestURI() == null ? "" : req.getRequestURI();
        int n = raw.length();
        for (int i = 0; i + 2 < n; i++) {
            if (raw.charAt(i) != '%') continue;
            String h = raw.substring(i + 1, i + 3).toUpperCase(java.util.Locale.ROOT);
            if (h.equals("2F") || h.equals("5C") || h.equals("25") || h.equals("2E")) return null;
        }
        for (String seg : raw.split("/", -1)) {
            int semi = seg.indexOf(';');
            String s = semi >= 0 ? seg.substring(0, semi) : seg;
            if (s.equals(".") || s.equals("..")) return null;
        }
        // A non-servlet wrapper that fills neither accessor has no servlet path to hand over: the raw
        // URI (already refused above when non-canonical) is the only path there is, and matching ""
        // instead would let every protected route skip its rule.
        if (req.getServletPath() == null && req.getPathInfo() == null) return raw;
        String sp = req.getServletPath() == null ? "" : req.getServletPath();
        String pi = req.getPathInfo() == null ? "" : req.getPathInfo();
        return sp + pi;
    }

    public static Pattern toRegex(String pat) {
        return toRegex(pat, false);
    }

    private static final Pattern NEVER = Pattern.compile("(?!)");

    public static Pattern toRegex(String pat, boolean placeholders) {
        if (placeholders && validateBraces(pat) != null) return NEVER;
        StringBuilder re = new StringBuilder("^");
        int i = 0;
        while (i < pat.length()) {
            char c = pat.charAt(i);
            if (c == '/' && pat.startsWith("**", i + 1)) {
                // `/**` — the leading slash is optional too, so /x/** matches /x.
                // Mid-pattern the NEXT slash stays literal, so /a/**/b needs a boundary
                // before b: /ab and /a/xb must not match (fail-open for exemptPaths).
                i += 3;
                if (i >= pat.length() || pat.charAt(i) == '/') {
                    re.append("(?:/.*)?");
                } else {
                    re.append("/.*");
                }
            } else if (c == '*' && i + 1 < pat.length() && pat.charAt(i + 1) == '*') {
                re.append(".*");
                i += 2;
                if (i < pat.length() && pat.charAt(i) == '/') i++;
            } else if (c == '*') {
                re.append("[^/]*");
                i++;
            } else if (placeholders && c == '{') {
                // validateBraces already proved this is a whole-segment {name}.
                re.append("[^/]+");
                i = pat.indexOf('}', i) + 1;
            } else if ("\\.+?^${}()|[]".indexOf(c) >= 0) {
                re.append('\\').append(c);
                i++;
            } else {
                re.append(c);
                i++;
            }
        }
        re.append('$');
        return Pattern.compile(re.toString());
    }

    /**
     * Checks the §11.4.1 placeholder grammar. Returns {@code null} when every
     * brace in {@code pat} is a valid whole-segment {@code {name}} (or there are
     * none), otherwise a message naming the first offence.
     */
    public static String validateBraces(String pat) {
        int n = pat.length();
        for (int i = 0; i < n; i++) {
            char c = pat.charAt(i);
            if (c == '}') return "unbalanced brace";
            if (c != '{') continue;
            int close = pat.indexOf('}', i + 1);
            int nextOpen = pat.indexOf('{', i + 1);
            if (close < 0 || (nextOpen >= 0 && nextOpen < close)) return "unbalanced brace";
            String name = pat.substring(i + 1, close);
            if (name.indexOf(':') >= 0) {
                return "regex placeholders are unsupported; use `*` for one segment or `**` for any depth";
            }
            if (name.isEmpty()) return "empty placeholder";
            if (!name.matches("[A-Za-z0-9_-]+")) {
                return "name may contain only letters, digits, `_`, `-`";
            }
            boolean startOk = i > 0 && pat.charAt(i - 1) == '/';
            boolean endOk = close + 1 == n || pat.charAt(close + 1) == '/';
            if (!startOk || !endOk) return "a placeholder must be a whole path segment";
            i = close;
        }
        return null;
    }
}
