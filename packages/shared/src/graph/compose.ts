/**
 * Compose the knowledge-graph artifact from its sources (ADR 0010).
 *
 * Inputs are plain data — already-fetched spans, already-parsed code-ref rows,
 * the service registry — so composition is deterministic and unit-testable;
 * all I/O (trace API, find-code-refs binary, registry file) lives with the
 * pipeline wiring.
 */

import type { CodeRefRow } from "./codeRefs.js";
import { codeRefEdges } from "./codeRefs.js";
import type { SpanRecord } from "./traceEdges.js";
import { deriveServiceEdges } from "./traceEdges.js";
import type { GraphNode, GraphService, KnowledgeGraph } from "./schema.js";
import { fileNodeId, flagNodeId, serviceForFile, serviceNodeId } from "./schema.js";

/** Boolean flag (factory project) gating graph composition + the agent tool. */
export const KNOWLEDGE_GRAPH_FLAG_KEY = "auto-factory-knowledge-graph";

export interface ComposeInputs {
  services: GraphService[];
  /** Observability spans for the estate's services (recent window). */
  spans?: SpanRecord[];
  /** Parsed find-code-refs rows from the PR-SHA run. */
  codeRefs?: CodeRefRow[];
  sha?: string;
}

export function composeGraph(inputs: ComposeInputs): KnowledgeGraph {
  const { services, spans = [], codeRefs = [], sha } = inputs;
  const nodes = new Map<string, GraphNode>();
  const gaps: string[] = [];

  for (const svc of services) {
    nodes.set(serviceNodeId(svc.key), {
      id: serviceNodeId(svc.key),
      kind: "service",
      label: svc.key,
      service: svc.key,
    });
  }

  const serviceEdges = deriveServiceEdges(spans, services);
  if (spans.length === 0) {
    gaps.push("traces: no span data — service_calls edges unavailable (telemetry gap or fetch skipped)");
  } else {
    const seen = new Set(
      spans.map((s) => s.serviceName).filter((n): n is string => !!n && services.some((svc) => svc.key === n)),
    );
    for (const svc of services) {
      if (!seen.has(svc.key)) gaps.push(`traces: no spans from service '${svc.key}' — its outbound calls are invisible`);
    }
  }

  const flagEdges = codeRefEdges(codeRefs);
  if (codeRefs.length === 0) gaps.push("code_refs: no rows — flag_wraps edges unavailable");
  for (const edge of flagEdges) {
    if (!nodes.has(edge.src)) {
      nodes.set(edge.src, { id: edge.src, kind: "flag", label: edge.src.replace(/^flag:/, "") });
    }
    if (!nodes.has(edge.dst)) {
      const path = edge.dst.replace(/^file:/, "");
      const svc = serviceForFile(services, path);
      nodes.set(edge.dst, {
        id: edge.dst,
        kind: "file",
        label: path,
        ...(svc ? { service: svc.key } : {}),
      });
    }
  }

  return {
    schema: 1,
    ...(sha ? { sha } : {}),
    services,
    nodes: [...nodes.values()],
    edges: [...serviceEdges, ...flagEdges],
    gaps,
  };
}

export { fileNodeId, flagNodeId, serviceNodeId };
