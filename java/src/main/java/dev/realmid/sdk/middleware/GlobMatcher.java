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

    /** Literal-brace mode ({@code exemptPaths}). */
    public static boolean match(String pattern, String path) {
        return toRegex(pattern).matcher(path).matches();
    }

    /** Placeholder mode ({@code mfaProtectedPaths}, {@code ScopeRule}). */
    public static boolean matchPlaceholders(String pattern, String path) {
        return toRegex(pattern, true).matcher(path).matches();
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
                re.append("(?:/.*)?");
                i += 3;
                if (i < pat.length() && pat.charAt(i) == '/') i++;
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
