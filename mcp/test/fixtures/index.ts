import type { DocsIndex } from "../../src/types";

const U = "https://github.com/Realm-ID/sdk/blob/main/docs";

// A tiny hand-made index: each tool is tested against this, independent of the real docs.
export const fixture: DocsIndex = {
  source: { repo: "Realm-ID/sdk", commit: "abc1234def", dirty: false, built_at: "2026-10-14T00:00:00Z", claims_source: "claims.yaml" },
  docs: [
    { id: "faq", title: "FAQ", path: "docs/faq.md", url: `${U}/faq.md` },
    { id: "error-reference", title: "Error reference", path: "docs/error-reference.md", url: `${U}/error-reference.md` },
  ],
  sections: [
    { doc: "faq", level: 3, heading: "Can I bring my own user ids?", anchor: "can-i-bring-my-own-user-ids", url: `${U}/faq.md#can-i-bring-my-own-user-ids`, text: "Yes, if they are UUIDs. A bulk import row may carry its own user_id." },
    { doc: "faq", level: 3, heading: "Does RealmID support SCIM?", anchor: "does-realmid-support-scim", url: `${U}/faq.md#does-realmid-support-scim`, text: "No. There is no SCIM route." },
    { doc: "faq", level: 3, heading: "How do refresh tokens rotate?", anchor: "how-do-refresh-tokens-rotate", url: `${U}/faq.md#how-do-refresh-tokens-rotate`, text: "Each refresh returns a new token. A user id is never changed by a refresh." },
  ],
  errors: [
    { code: "tenant_required", group: "Auth-flow codes", kind: "When", description: "called without a tenantId", action: "Surface a tenant picker.", anchor: "auth-flow-codes", url: `${U}/error-reference.md#auth-flow-codes` },
    { code: "weird_pipe", group: "Auth-flow codes", kind: "Meaning", description: "has `a | b` inside", action: "Do x.", anchor: "auth-flow-codes", url: `${U}/error-reference.md#auth-flow-codes` },
  ],
  claims: [
    { id: "no-scim", source: "claims.yaml", statement: "RealmID has no SCIM route.", kind: "absence", doc: ["docs/faq.md#does-realmid-support-scim"], url: `${U}/claims.yaml` },
  ],
};
