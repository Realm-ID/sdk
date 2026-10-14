// Shape of src/generated/index.json, written by scripts/build-index.mjs.

export interface SourceInfo {
  repo: string;
  commit: string;
  dirty: boolean;
  built_at: string;
  claims_source: string;
}

export interface DocInfo {
  id: string;
  title: string;
  path: string;
  url: string;
}

export interface Section {
  doc: string;
  level: number;
  heading: string;
  anchor: string;
  text: string;
  url: string;
}

export interface ErrorRow {
  code: string;
  group: string;
  /** The table's second header: "When" or "Meaning". */
  kind: string;
  description: string;
  action: string;
  anchor: string;
  url: string;
}

/** A claim from docs/claims.yaml (id, statement, kind, note, doc[]) or, failing that, a FAQ `Claim:` line. */
export interface Claim {
  id: string;
  source: string;
  url: string;
  statement?: string;
  kind?: string;
  note?: string;
  /** claims.yaml: `path#anchor` entries. */
  doc?: string[] | string;
  /** FAQ fallback only. */
  anchor?: string;
  heading?: string;
  text?: string;
  [extra: string]: unknown;
}

export interface DocsIndex {
  source: SourceInfo;
  docs: DocInfo[];
  sections: Section[];
  errors: ErrorRow[];
  claims: Claim[];
}
