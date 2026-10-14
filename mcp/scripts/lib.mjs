// Pure parsing helpers for the docs index. Used by build-index.mjs (at build time) and by the tests.
// Nothing here touches the network or the file system.

/** GitHub-style heading slug (github-slugger): lowercase, drop punctuation, spaces to hyphens. */
export function slugBase(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Strip inline markdown from a heading so the slug matches what GitHub renders. */
export function plainHeading(raw) {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

/**
 * Split a markdown doc into sections, one per heading. Headings inside code fences are ignored.
 * Anchors are GitHub slugs with -1, -2 suffixes for duplicates.
 * @returns {{level:number, heading:string, anchor:string, text:string}[]}
 */
export function parseSections(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  const seen = new Map();
  let fence = null;
  let cur = null;
  for (const line of lines) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = !fence && line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const heading = plainHeading(h[2]);
      let slug = slugBase(heading);
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      if (n > 0) slug = `${slug}-${n}`;
      cur = { level: h[1].length, heading, anchor: slug, lines: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      cur = { level: 0, heading: "", anchor: "", lines: [] };
      sections.push(cur);
    }
    cur.lines.push(line);
  }
  return sections
    .map((s) => ({ level: s.level, heading: s.heading, anchor: s.anchor, text: s.lines.join("\n").trim() }))
    .filter((s) => s.heading !== "" || s.text !== "");
}

/** Split one markdown table row on `|`, ignoring pipes inside backtick spans. */
export function splitRow(line) {
  const cells = [];
  let cur = "";
  let tick = false;
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      tick = !tick;
      cur += c;
    } else if (c === "|" && !tick) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parse every error-code table in error-reference.md. A table counts when its header's first cell is
 * `Code` and it has three columns (`Code | When | What to do` or `Code | Meaning | What to do`).
 * @returns {{code:string, group:string, kind:string, description:string, action:string, anchor:string}[]}
 */
export function parseErrorCodes(markdown) {
  const out = [];
  for (const sec of parseSections(markdown)) {
    const lines = sec.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim().startsWith("|")) continue;
      const head = splitRow(lines[i]);
      if (head.length !== 3 || head[0].toLowerCase() !== "code") continue;
      const kind = head[1];
      i += 2; // header + separator
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        const cells = splitRow(lines[i]);
        if (cells.length < 3) continue;
        out.push({
          code: cells[0].replace(/^`+|`+$/g, ""),
          group: sec.heading,
          kind,
          description: cells[1],
          action: cells.slice(2).join(" | "),
          anchor: sec.anchor,
        });
      }
    }
  }
  return out;
}

/**
 * `Claim: \`id\`` lines (the FAQ's hard rules). The claim's text is the section it sits in.
 * @returns {{id:string, doc:string, anchor:string, heading:string, text:string}[]}
 */
export function parseClaimLines(doc, markdown) {
  const out = [];
  for (const sec of parseSections(markdown)) {
    for (const m of sec.text.matchAll(/^Claim:\s*`([^`]+)`\s*$/gm)) {
      out.push({ id: m[1], doc, anchor: sec.anchor, heading: sec.heading, text: sec.text });
    }
  }
  return out;
}
