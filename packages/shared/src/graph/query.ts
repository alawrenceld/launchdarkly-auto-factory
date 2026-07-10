/**
 * Agent-facing queries over the knowledge-graph artifact.
 *
 * These back the `query_dependencies` tool: small, deterministic traversals
 * that return compact JSON the model can reason over — not graph dumps.
 */

import type { GraphEdge, KnowledgeGraph } from "./schema.js";
import { serviceForFile, serviceNodeId } from "./schema.js";

export interface NeighborHit {
  id: string;
  kind: string;
  /** Edge that connected it, for evidence. */
  via: GraphEdge;
  depth: number;
}

/**
 * BFS over edges from `nodeId`. direction "dependents" walks edges INTO the
 * node (who is affected by it); "dependencies" walks edges OUT of it (what it
 * relies on). Depth-capped; cycle-safe.
 */
export function neighbors(
  graph: KnowledgeGraph,
  nodeId: string,
  direction: "dependents" | "dependencies",
  maxDepth = 3,
): NeighborHit[] {
  const hits: NeighborHit[] = [];
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        const [from, to] = direction === "dependents" ? [edge.dst, edge.src] : [edge.src, edge.dst];
        if (from !== id || visited.has(to)) continue;
        visited.add(to);
        const node = graph.nodes.find((n) => n.id === to);
        hits.push({ id: to, kind: node?.kind ?? "unknown", via: edge, depth });
        next.push(to);
      }
    }
    frontier = next;
  }
  return hits;
}

export interface BlastRadius {
  /** Services the changed files belong to. */
  changedServices: string[];
  /** Changed files that map to no registered service (unattributed). */
  unmappedFiles: string[];
  /** Services that (transitively) call a changed service — consumers at risk. */
  dependentServices: { service: string; depth: number; evidence?: string }[];
  /** Services the changed services call — dependencies whose contracts matter. */
  upstreamServices: { service: string; depth: number; evidence?: string }[];
  /** Flags already wrapping code in the changed files or changed services. */
  flagsOnChangedCode: { flag: string; evidence?: string }[];
  /** Coverage caveats copied from the artifact — a thin graph is a gap, not safety. */
  gaps: string[];
}

/** The zero-argument preset: impact of this PR's changed files. */
export function blastRadius(graph: KnowledgeGraph, changedFiles: string[], maxDepth = 3): BlastRadius {
  const changedServices = new Set<string>();
  const unmappedFiles: string[] = [];
  for (const file of changedFiles) {
    const svc = serviceForFile(graph.services, file);
    if (svc) changedServices.add(svc.key);
    else unmappedFiles.push(file);
  }

  const dependents = new Map<string, NeighborHit>();
  const upstream = new Map<string, NeighborHit>();
  for (const key of changedServices) {
    for (const hit of neighbors(graph, serviceNodeId(key), "dependents", maxDepth)) {
      if (hit.kind !== "service") continue;
      const existing = dependents.get(hit.id);
      if (!existing || hit.depth < existing.depth) dependents.set(hit.id, hit);
    }
    for (const hit of neighbors(graph, serviceNodeId(key), "dependencies", maxDepth)) {
      if (hit.kind !== "service") continue;
      const existing = upstream.get(hit.id);
      if (!existing || hit.depth < existing.depth) upstream.set(hit.id, hit);
    }
  }
  for (const key of changedServices) {
    dependents.delete(serviceNodeId(key));
    upstream.delete(serviceNodeId(key));
  }

  const changedFileIds = new Set(changedFiles.map((f) => `file:${f.replace(/^\/+/, "")}`));
  const flags = new Map<string, string | undefined>();
  for (const edge of graph.edges) {
    if (edge.kind !== "flag_wraps") continue;
    const dstNode = graph.nodes.find((n) => n.id === edge.dst);
    const inChangedFile = changedFileIds.has(edge.dst);
    const inChangedService = dstNode?.service !== undefined && changedServices.has(dstNode.service);
    if (inChangedFile || inChangedService) {
      flags.set(edge.src.replace(/^flag:/, ""), edge.evidence);
    }
  }

  const toEntry = (hit: NeighborHit) => ({
    service: hit.id.replace(/^service:/, ""),
    depth: hit.depth,
    ...(hit.via.evidence ? { evidence: hit.via.evidence } : {}),
  });

  return {
    changedServices: [...changedServices].sort(),
    unmappedFiles,
    dependentServices: [...dependents.values()].map(toEntry).sort((a, b) => a.depth - b.depth),
    upstreamServices: [...upstream.values()].map(toEntry).sort((a, b) => a.depth - b.depth),
    flagsOnChangedCode: [...flags.entries()].map(([flag, evidence]) => ({
      flag,
      ...(evidence ? { evidence } : {}),
    })),
    gaps: graph.gaps,
  };
}
