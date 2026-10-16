package dev.realmid.sdk.middleware;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** SPEC 10.2: a mid-pattern {@code **} keeps the segment boundary (exemptPaths fail-open fix). Same table as Go and TS. */
class GlobMatcherBoundaryTest {

    private static void check(String pat, String path, boolean want) {
        assertEquals(want, GlobMatcher.match(pat, path), pat + " vs " + path);
        assertEquals(want, GlobMatcher.matchPlaceholders(pat, path), "(placeholders) " + pat + " vs " + path);
    }

    @Test
    void SPEC10_2_midPatternDoubleStarKeepsTheSegmentBoundary() {
        check("/a/**/b", "/a/b", true);
        check("/a/**/b", "/a/x/b", true);
        check("/a/**/b", "/a/x/y/b", true);
        check("/a/**/b", "/ab", false);
        check("/a/**/b", "/a/xb", false);
        check("/a/**/b", "/axb", false);
    }

    @Test
    void SPEC10_2_trailingDoubleStarMatchesTheBareParentButNotASiblingPrefix() {
        check("/x/**", "/x", true);
        check("/x/**", "/x/", true);
        check("/x/**", "/x/y", true);
        check("/x/**", "/xy", false);
    }

    @Test
    void SPEC10_2_rootDoubleStarMatchesEverything() {
        check("/**", "/", true);
        check("/**", "/a", true);
        check("/**", "/a/b/c", true);
    }
}
