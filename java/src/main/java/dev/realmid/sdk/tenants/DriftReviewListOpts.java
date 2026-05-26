package dev.realmid.sdk.tenants;

/** Filters for {@link DriftReviewsClient#list}. All fields optional (SPEC §6.8). */
public record DriftReviewListOpts(String userId, String cursor, Integer limit) {
    public static DriftReviewListOpts empty() { return new DriftReviewListOpts(null, null, null); }
    public static DriftReviewListOpts forUser(String userId) { return new DriftReviewListOpts(userId, null, null); }
}
