/**
 * Agent graph walker.
 *
 * Walks a LaunchDarkly `AgentGraphDefinition` (resolved natively via the AI SDK's
 * `agentGraph()` — LaunchDarkly delivers the structure + each node's resolved AI
 * config, but does NOT execute the graph) by dispatching each node through an
 * `AgentRunner` (Vega or Anthropic) and following edges whose handoff conditions
 * are satisfied by the tags agents set.
 *
 * Handoff conditions live in each edge's freeform `handoff` object:
 *   - require_tags: take the edge only if ALL listed tags are present/equal
 *   - skip_if_tags: do NOT take the edge if ALL listed tags are present/equal
 *     (e.g. research sets {skip_flagging: "true"} → the flagging edge is skipped,
 *      short-circuiting the chain — "this PR needs no flag")
 *
 * Designed for the linear/conditional chains we use today; one outgoing edge is
 * taken per node. Per-node generation metrics and per-edge handoff metrics are
 * recorded back to LaunchDarkly via the AI-config and graph trackers.
 */

import type { AgentGraphDefinition, AgentGraphNode, LDGraphTracker } from "@launchdarkly/server-sdk-ai";
import type { AgentNodeResult, AgentRunner } from "./agentRunner.js";

export interface NodeRun {
  configKey: string;
  status: AgentNodeResult["status"];
  output: string;
  tags: Record<string, string>;
}

/** An outgoing edge that could NOT be taken because its `require_tags` weren't met. */
export interface UnmetEdge {
  /** Target node key the edge would have advanced to. */
  target: string;
  /** The required tag→value pairs that were absent or mismatched. */
  requireMissing: Record<string, string>;
}

/**
 * Why the walk stopped before a terminal node: the current node had outgoing
 * edges, but every one was blocked by an unmet `require_tags` handoff (NOT an
 * intentional `skip_if_tags` short-circuit, and NOT a genuine no-edge terminal).
 * This is the "silently stalled" case issue #9 wants surfaced — a required
 * routing tag was never produced, so the chain can't advance.
 */
export interface StallInfo {
  /** The node the chain stalled at. */
  node: string;
  /** Tags present when it stalled (what the node actually emitted). */
  tags: Record<string, string>;
  /** The outgoing edges that couldn't be taken, with the missing tags. */
  unmet: UnmetEdge[];
}

export interface WalkResult {
  runs: NodeRun[];
  /** Tags accumulated across all nodes. */
  tags: Record<string, string>;
  /** Node keys never reached because an edge condition stopped the chain. */
  skipped: string[];
  /**
   * Set when the chain stopped on an unmet handoff (a required tag was never
   * emitted) rather than at a terminal node or an intentional skip. Undefined
   * for a clean finish. Lets the caller report "stalled — X required Y, absent"
   * instead of a misleading verdict.
   */
  stalledAt?: StallInfo;
}

/**
 * Progress events emitted as the walk advances, for live UIs (e.g. the Cursor
 * extension streaming research → flag → metrics → test → review). Optional and
 * additive: callers that don't pass `onEvent` (the GitHub Action) are unaffected.
 */
export type WalkEvent =
  | { type: "node-start"; configKey: string; index: number }
  | { type: "node-complete"; configKey: string; index: number; run: NodeRun }
  | { type: "stalled"; stall: StallInfo };

/** All key/value pairs in `cond` are present and equal in `tags`. */
function tagsMatch(tags: Record<string, string>, cond: Record<string, string>): boolean {
  return Object.entries(cond).every(([k, v]) => tags[k] === v);
}

/** Read a `{key:value}` tag map out of an edge handoff field. */
function handoffTags(handoff: Record<string, unknown> | undefined, field: string): Record<string, string> | undefined {
  const v = handoff?.[field];
  return v && typeof v === "object" ? (v as Record<string, string>) : undefined;
}
function handoffNumber(handoff: Record<string, unknown> | undefined, field: string): number | undefined {
  const v = handoff?.[field];
  return typeof v === "number" ? v : undefined;
}
function handoffString(handoff: Record<string, unknown> | undefined, field: string): string | undefined {
  const v = handoff?.[field];
  return typeof v === "string" ? v : undefined;
}
function handoffStringArray(handoff: Record<string, unknown> | undefined, field: string): string[] | undefined {
  const v = handoff?.[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/**
 * Build a node's prompt. Each node runs in its own conversation, so the prompt
 * carries the repo + PR header and, for non-root nodes, the previous agent's
 * full brief (the downstream agent's instructions tell it to parse this).
 */
function buildPrompt(hasInbound: boolean, ctx: Record<string, unknown>): string {
  const header = [
    ctx.REPO ? `Repository: ${ctx.REPO}` : "",
    ctx.PR_NUMBER ? `Pull request: #${ctx.PR_NUMBER}` : "",
    ctx.PR_TITLE ? `Title: ${ctx.PR_TITLE}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!hasInbound) {
    return `${header}${ctx.PR_BODY ? `\n\n${ctx.PR_BODY}` : ""}`.trim();
  }
  const brief = typeof ctx.PREVIOUS_STEP_OUTPUT === "string" ? ctx.PREVIOUS_STEP_OUTPUT : "";
  return `${header}\n\n${brief}`.trim();
}

function lastAssistantText(result: AgentNodeResult): string {
  const finals = result.messages.filter((m) => m.role === "assistant");
  const fin = finals.find((m) => m.isFinal) ?? finals[finals.length - 1];
  return fin?.content ?? "";
}

/** Every node key referenced by the graph (root + all edge sources/targets). */
function allNodeKeys(graphDef: AgentGraphDefinition): string[] {
  const raw = graphDef.getConfig();
  const keys = new Set<string>();
  if (raw.root) keys.add(raw.root);
  for (const [source, edges] of Object.entries(raw.edges ?? {})) {
    keys.add(source);
    for (const e of edges) keys.add(e.key);
  }
  return [...keys];
}

export async function walkGraph(
  graphDef: AgentGraphDefinition,
  runner: AgentRunner,
  context: Record<string, unknown>,
  graphTracker?: LDGraphTracker,
  onEvent?: (event: WalkEvent) => void,
): Promise<WalkResult> {
  const runs: NodeRun[] = [];
  const accumulatedTags: Record<string, string> = {};
  const ctx: Record<string, unknown> = { ...context };
  const visited = new Set<string>();

  let node: AgentGraphNode | null = graphDef.rootNode();
  // Handoff of the edge we traversed INTO the current node (root has none).
  let inboundHandoff: Record<string, unknown> | undefined;
  let stalledAt: StallInfo | undefined;

  while (node && !visited.has(node.getKey())) {
    const key = node.getKey();
    visited.add(key);

    const cfg = node.getConfig();
    const maxTurns = handoffNumber(inboundHandoff, "max_turns");
    const requestType = handoffString(inboundHandoff, "request_type");
    const capabilities = handoffStringArray(inboundHandoff, "capabilities");
    onEvent?.({ type: "node-start", configKey: key, index: runs.length });
    const result = await runner.runNode({
      configKey: key,
      prompt: buildPrompt(inboundHandoff !== undefined, ctx),
      ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
      ...(cfg.model?.name ? { model: cfg.model.name } : {}),
      tracker: cfg.createTracker(),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(requestType ? { requestType } : {}),
      ...(capabilities ? { capabilities } : {}),
    });

    Object.assign(accumulatedTags, result.tags);
    const output = lastAssistantText(result);
    ctx.PREVIOUS_STEP_OUTPUT = output;
    const run: NodeRun = { configKey: key, status: result.status, output, tags: result.tags };
    runs.push(run);
    onEvent?.({ type: "node-complete", configKey: key, index: runs.length - 1, run });

    // Pick the next edge whose handoff conditions pass.
    let next: string | null = null;
    let nextHandoff: Record<string, unknown> | undefined;
    for (const edge of node.getEdges()) {
      const h = edge.handoff;
      const require = handoffTags(h, "require_tags");
      if (require && !tagsMatch(accumulatedTags, require)) continue;
      const skip = handoffTags(h, "skip_if_tags");
      if (skip && tagsMatch(accumulatedTags, skip)) continue;
      next = edge.key;
      nextHandoff = h;
      break;
    }

    // No edge taken: distinguish a genuine terminal (no outgoing edges) and an
    // intentional skip (every blocked edge matched its skip_if) from a real
    // stall (an outgoing edge's require_tags was never satisfied).
    if (!next) {
      const edges = node.getEdges();
      const unmet: UnmetEdge[] = [];
      for (const edge of edges) {
        const h = edge.handoff;
        const skip = handoffTags(h, "skip_if_tags");
        if (skip && tagsMatch(accumulatedTags, skip)) continue; // intentionally skipped
        const require = handoffTags(h, "require_tags");
        if (require && !tagsMatch(accumulatedTags, require)) {
          const requireMissing: Record<string, string> = {};
          for (const [k, v] of Object.entries(require)) {
            if (accumulatedTags[k] !== v) requireMissing[k] = v;
          }
          unmet.push({ target: edge.key, requireMissing });
        }
      }
      if (unmet.length > 0) {
        stalledAt = { node: key, tags: { ...accumulatedTags }, unmet };
        onEvent?.({ type: "stalled", stall: stalledAt });
      }
    }

    if (next) graphTracker?.trackHandoffSuccess(key, next);
    node = next ? graphDef.getNode(next) : null;
    inboundHandoff = nextHandoff;
  }

  const reached = new Set(runs.map((r) => r.configKey));
  const skipped = allNodeKeys(graphDef).filter((k) => !reached.has(k));

  return { runs, tags: accumulatedTags, skipped, ...(stalledAt ? { stalledAt } : {}) };
}
