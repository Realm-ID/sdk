package dev.realmid.sdk.middleware;

import java.util.regex.Pattern;

/** Tiny glob matcher: {@code *} = one path segment; {@code **} = any. */
public final class GlobMatcher {
    private GlobMatcher() {}

    public static boolean match(String pattern, String path) {
        return toRegex(pattern).matcher(path).matches();
    }

    public static Pattern toRegex(String pat) {
        StringBuilder re = new StringBuilder("^");
        int i = 0;
        while (i < pat.length()) {
            char c = pat.charAt(i);
            if (c == '*' && i + 1 < pat.length() && pat.charAt(i + 1) == '*') {
                re.append(".*");
                i += 2;
                if (i < pat.length() && pat.charAt(i) == '/') i++;
            } else if (c == '*') {
                re.append("[^/]*");
                i++;
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
}
