/**
 * flag→code wrap-point edges from `ld-find-code-refs` CSV output.
 *
 * The pipeline runs the find-code-refs binary at the PR's SHA with CSV output
 * (a documented output mode), which — unlike the refs attached to the flag in
 * LaunchDarkly, which reflect the last default-branch scan — includes the flag
 * wiring the PR itself adds. The same rows feed the reviewer's evidence and
 * the cleanup artifact; here they become graph edges.
 *
 * The parser is header-driven and tolerant: find-code-refs CSV columns have
 * shifted across versions, so we locate the flag-key / path / line columns by
 * name rather than position, and skip rows that don't parse rather than throw.
 */

import type { GraphEdge } from "./schema.js";
import { fileNodeId, flagNodeId } from "./schema.js";

export interface CodeRefRow {
  flagKey: string;
  /** Repo-relative path. */
  path: string;
  line?: number;
}

const FLAG_COLUMNS = ["flagkey", "flag_key", "flag"];
const PATH_COLUMNS = ["path", "filepath", "file"];
const LINE_COLUMNS = ["startinglinenumber", "linenumber", "line"];

/** Minimal CSV line splitter honoring double-quoted fields ("" = escaped quote). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/** Parse find-code-refs CSV text into rows. Returns [] on unrecognized headers. */
export function parseCodeRefsCsv(csv: string): CodeRefRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerLine = lines[0];
  if (lines.length < 2 || headerLine === undefined) return [];
  const header = splitCsvLine(headerLine).map((h) => h.trim().toLowerCase().replace(/[^a-z_]/g, ""));
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const flagIdx = col(FLAG_COLUMNS);
  const pathIdx = col(PATH_COLUMNS);
  const lineIdx = col(LINE_COLUMNS);
  if (flagIdx < 0 || pathIdx < 0) return [];

  const rows: CodeRefRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const flagKey = cells[flagIdx]?.trim();
    const path = cells[pathIdx]?.trim().replace(/^\/+/, "");
    if (!flagKey || !path) continue;
    const lineNo = lineIdx >= 0 ? Number.parseInt(cells[lineIdx] ?? "", 10) : Number.NaN;
    rows.push({ flagKey, path, ...(Number.isFinite(lineNo) ? { line: lineNo } : {}) });
  }
  return rows;
}

/** One flag_wraps edge per (flag, file); evidence lists the matched lines. */
export function codeRefEdges(rows: CodeRefRow[]): GraphEdge[] {
  const byPair = new Map<string, { flagKey: string; path: string; lines: number[] }>();
  for (const row of rows) {
    const key = `${row.flagKey} ${row.path}`;
    const entry = byPair.get(key) ?? { flagKey: row.flagKey, path: row.path, lines: [] };
    if (row.line !== undefined) entry.lines.push(row.line);
    byPair.set(key, entry);
  }
  return [...byPair.values()].map(({ flagKey, path, lines }) => ({
    src: flagNodeId(flagKey),
    dst: fileNodeId(path),
    kind: "flag_wraps" as const,
    provenance: "code_refs" as const,
    evidence: lines.length ? `${path}:${lines.sort((a, b) => a - b).join(",")}` : path,
    weight: Math.max(lines.length, 1),
  }));
}
