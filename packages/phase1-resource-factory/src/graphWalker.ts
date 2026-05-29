/**
 * Agent graph walker. Walks an AgentGraph by dispatching each node to Vega and
 * following edges whose handoff conditions are satisfied by the tags agents set.
 *
 * Conditions (from the reference handoff model):
 *   - require_tags: take the edge only if ALL listed tags are present/equal
 *   - skip_if_tags: do NOT take the edge if ALL listed tags are present/equal
 *     (e.g. research sets {skip_flagging: "true"} → the flagging edge is skipped,
 *      which short-circuits the rest of the chain — "this PR needs no flag")
 *
 * Designed for the linear/conditional chains we use today; complex fan-out/join
 * is intentionally simplified (one outgoing edge taken per node).
 */

import type { VegaClient, VegaStatusResult } from "@auto-factory/shared";

export interface Handoff {
  prompt_template?: string;
  max_turns?: number;
  request_type?: string;
  require_tags?: Record<string, string>;
  skip_if_tags?: Record<string, string>;
}

export interface AgentGraphEdge {
  key: string;
  sourceConfig: string;
  targetConfig: string;
  handoff?: Handoff;
}

export interface AgentGraph {
  key: string;
  rootConfigKey: string;
  edges: AgentGraphEdge[];
}

export interface NodeRun {
  configKey: string;
  status: VegaStatusResult["status"];
  output: string;
  tags: Record<string, string>;
}

export interface WalkResult {
  runs: NodeRun[];
  /** Tags accumulated across all nodes. */
  tags: Record<string, string>;
  /** Node keys that were never reached because an edge condition stopped the chain. */
  skipped: string[];
}

/** All key/value pairs in `cond` are present and equal in `tags`. */
function tagsMatch(tags: Record<string, string>, cond?: Record<string, string>): boolean {
  if (!cond) return false;
  return Object.entries(cond).every(([k, v]) => tags[k] === v);
}

function render(template: string | undefined, context: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    context[key] === undefined ? "" : String(context[key]),
  );
}

function lastAssistantText(result: VegaStatusResult): string {
  const finals = result.messages.filter((m) => m.role === "assistant");
  const fin = finals.find((m) => m.isFinal) ?? finals[finals.length - 1];
  return fin?.content ?? "";
}

export async function walkGraph(
  graph: AgentGraph,
  vega: VegaClient,
  context: Record<string, unknown>,
): Promise<WalkResult> {
  const runs: NodeRun[] = [];
  const accumulatedTags: Record<string, string> = {};
  const ctx: Record<string, unknown> = { ...context };
  const visited = new Set<string>();

  let current: string | null = graph.rootConfigKey;

  while (current && !visited.has(current)) {
    visited.add(current);

    // Use the inbound edge's handoff for prompt/turn settings (root has none).
    const inbound = graph.edges.find((e) => e.targetConfig === current);
    const result = await vega.runNode({
      configKey: current,
      prompt: render(inbound?.handoff?.prompt_template, ctx),
      context: ctx,
      ...(inbound?.handoff?.max_turns !== undefined ? { maxTurns: inbound.handoff.max_turns } : {}),
    });

    Object.assign(accumulatedTags, result.tags);
    const output = lastAssistantText(result);
    ctx.PREVIOUS_STEP_OUTPUT = output;
    runs.push({ configKey: current, status: result.status, output, tags: result.tags });

    // Pick the next edge whose conditions pass.
    let next: string | null = null;
    for (const edge of graph.edges.filter((e) => e.sourceConfig === current)) {
      const h = edge.handoff;
      if (h?.require_tags && !tagsMatch(accumulatedTags, h.require_tags)) continue;
      if (h?.skip_if_tags && tagsMatch(accumulatedTags, h.skip_if_tags)) continue;
      next = edge.targetConfig;
      break;
    }
    current = next;
  }

  const reached = new Set(runs.map((r) => r.configKey));
  const skipped = [...new Set(graph.edges.map((e) => e.targetConfig))].filter((k) => !reached.has(k));

  return { runs, tags: accumulatedTags, skipped };
}
