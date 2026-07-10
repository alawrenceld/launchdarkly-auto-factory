/**
 * Knowledge-graph artifact schema (ADR 0010).
 *
 * The graph is COMPOSED from LaunchDarkly-native sources rather than extracted
 * by a code-graph tool: service→service edges derived from observability
 * traces, flag→code wrap points from `ld-find-code-refs` output at the PR SHA,
 * and changed-file→service attribution from the service registry's directory
 * mapping. The schema is deliberately source-agnostic — every edge carries its
 * provenance — so additional sources (a static import extractor, a first-party
 * service-map API) can be merged in later without consumers changing.
 */

/** One deployable service, from the service registry (config/services.yaml). */
export interface GraphService {
  key: string;
  /** frontend | backend (Beacon's scope side). */
  side?: string;
  /** owning repo, e.g. "ttotenberg-ld/launchdarkly-autofactory-application". */
  repo?: string;
  /**
   * Repo-relative directory that holds this service's code (e.g. "gateway").
   * Drives changed-file→service attribution; omit for single-service repos.
   */
  dir?: string;
  /**
   * Hostnames (or unique host substrings) this service serves in deployed
   * environments, used to resolve outbound-call targets seen in trace spans.
   * The registry's statusUrl host is always considered in addition.
   */
  hosts?: string[];
}

export type GraphNodeKind = "service" | "flag" | "file";

export interface GraphNode {
  /** "service:gateway" | "flag:enable-x" | "file:gateway/src/app.ts" */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Owning service key, when attributable (files; the service node itself). */
  service?: string;
}

export type GraphEdgeKind =
  /** src service makes calls to dst service (runtime-observed). */
  | "service_calls"
  /** src flag gates code at dst (file node). */
  | "flag_wraps";

export type GraphEdgeProvenance =
  /** Derived from LaunchDarkly observability trace spans (deployed topology). */
  | "traces"
  /** From ld-find-code-refs output at the PR SHA (PR-accurate). */
  | "code_refs";

export interface GraphEdge {
  /** Node id. */
  src: string;
  /** Node id. */
  dst: string;
  kind: GraphEdgeKind;
  provenance: GraphEdgeProvenance;
  /** Human-auditable pointer: a span target host, or "path:line". */
  evidence?: string;
  /** Occurrence count where meaningful (e.g. observed calls in the window). */
  weight?: number;
}

export interface KnowledgeGraph {
  schema: 1;
  /** Head SHA the code-refs source was generated at, when known. */
  sha?: string;
  services: GraphService[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Sources that contributed nothing (e.g. no trace data for a service —
   * telemetry gap). Surfaced so a thin graph reads as "uncovered", not "safe".
   */
  gaps: string[];
}

export const serviceNodeId = (key: string): string => `service:${key}`;
export const flagNodeId = (key: string): string => `flag:${key}`;
export const fileNodeId = (path: string): string => `file:${path.replace(/^\/+/, "")}`;

/**
 * Attribute a repo-relative file path to a service via the registry's
 * directory mapping. Longest matching dir wins; undefined when unmapped.
 */
export function serviceForFile(services: GraphService[], filePath: string): GraphService | undefined {
  const clean = filePath.replace(/^\/+/, "");
  let best: GraphService | undefined;
  for (const svc of services) {
    if (!svc.dir) continue;
    const dir = svc.dir.replace(/^\/+|\/+$/g, "") + "/";
    if (clean.startsWith(dir) && (!best?.dir || dir.length > best.dir.length + 1)) best = svc;
  }
  return best;
}
