// The docs tools as pure functions over the bundled index. No I/O, so every one is testable against
// a fixture. The MCP wiring lives in server.ts.
import type { Claim, DocsIndex, ErrorRow, Section, SourceInfo } from "./types";

const STOP = new Set([
  "a", "an", "the", "i", "my", "me", "we", "our", "you", "your", "of", "to", "is", "are", "do", "does",
  "can", "how", "what", "in", "on", "for", "and", "or", "it", "with", "be", "if", "that", "this",
]);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

export interface SearchHit {
  doc: string;
  heading: string;
  anchor: string;
  url: string;
  snippet: string;
  score: number;
}

function snippetFor(text: string, terms: Set<string>): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 80);
  const piece = flat.slice(start, start + 260).trim();
  return `${start > 0 ? "..." : ""}${piece}${start + 260 < flat.length ? "..." : ""}`;
}

/** Ranked sections for a free-text query. Headings weigh more than body text. */
export function searchDocs(index: DocsIndex, query: string, limit = 5) {
  const terms = new Set(tokenize(query));
  const n = index.sections.length;
  const docs = index.sections.map((s) => ({
    s,
    head: tokenize(s.heading),
    body: tokenize(s.text),
  }));
  const df = new Map<string, number>();
  for (const t of terms) {
    df.set(t, docs.filter((d) => d.head.includes(t) || d.body.includes(t)).length);
  }
  const avg = docs.reduce((a, d) => a + d.body.length, 0) / Math.max(1, n);
  const hits: SearchHit[] = [];
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      const inHead = d.head.filter((w) => w === t).length;
      const tf = d.body.filter((w) => w === t).length;
      if (inHead + tf === 0) continue;
      matched++;
      const bm = (tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.body.length) / Math.max(1, avg)));
      score += idf * (bm + 3 * inHead);
    }
    if (matched === 0) continue;
    // Reward covering more of the query, and a heading that covers all of it.
    score *= 0.5 + matched / terms.size;
    if (terms.size > 1 && [...terms].every((t) => d.head.includes(t))) score *= 1.5;
    hits.push({
      doc: d.s.doc,
      heading: d.s.heading,
      anchor: d.s.anchor,
      url: d.s.url,
      snippet: snippetFor(d.s.text, terms),
      score: Math.round(score * 100) / 100,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { source: index.source, query, results: hits.slice(0, Math.max(1, Math.min(limit, 20))) };
}

export type Result<T> = ({ ok: true; source: SourceInfo } & T) | { ok: false; source: SourceInfo; error: string };

export function getSection(index: DocsIndex, doc: string, anchor: string): Result<{ section: Section }> {
  const source = index.source;
  const inDoc = index.sections.filter((s) => s.doc === doc);
  if (inDoc.length === 0) {
    return { ok: false, source, error: `Unknown doc '${doc}'. Known docs: ${index.docs.map((d) => d.id).join(", ")}.` };
  }
  const want = anchor.replace(/^#/, "").toLowerCase();
  const section = inDoc.find((s) => s.anchor === want);
  if (!section) {
    const near = inDoc.map((s) => s.anchor).filter((a) => a.includes(want.slice(0, 12)) || want.includes(a)).slice(0, 15);
    const list = (near.length ? near : inDoc.map((s) => s.anchor).slice(0, 30)).join(", ");
    return { ok: false, source, error: `No section '${anchor}' in '${doc}'. Anchors include: ${list}. Use search_docs to find one.` };
  }
  return { ok: true, source, section };
}

export function getClaim(index: DocsIndex, id: string): Result<{ claim: Claim & { sections: { doc: string; anchor: string; url: string }[] } }> {
  const source = index.source;
  const want = id.trim().replace(/^`|`$/g, "").toLowerCase();
  const claim = index.claims.find((c) => c.id.toLowerCase() === want);
  if (!claim) {
    return { ok: false, source, error: `Unknown claim '${id}'. Known claims: ${index.claims.map((c) => c.id).join(", ")}.` };
  }
  const refs = (Array.isArray(claim.doc) ? claim.doc : claim.doc ? [claim.doc] : []).map(String);
  const sections = refs.flatMap((r) => {
    const [path, anchor = ""] = r.split("#");
    const d = index.docs.find((x) => x.path === path);
    if (!d) return [];
    return [{ doc: d.id, anchor, url: anchor ? `${d.url}#${anchor}` : d.url }];
  });
  // pinned_by names internal test identifiers; it is not part of the partner-facing answer.
  const { pinned_by: _internal, ...rest } = claim as Claim & { pinned_by?: unknown };
  return { ok: true, source, claim: { ...rest, sections } };
}

export function explainError(index: DocsIndex, code: string): Result<{ error: ErrorRow }> {
  const source = index.source;
  const want = code.trim().replace(/^`+|`+$/g, "").toLowerCase();
  const row = index.errors.find((e) => e.code.toLowerCase() === want);
  if (!row) {
    return {
      ok: false,
      source,
      error: `The error reference has no row for '${code}'. It may be an issuer wire code not yet documented there; try search_docs. Documented codes: ${index.errors.map((e) => e.code).join(", ")}.`,
    };
  }
  return { ok: true, source, error: row };
}
