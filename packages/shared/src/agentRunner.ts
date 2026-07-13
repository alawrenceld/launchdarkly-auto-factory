/**
 * Provider-agnostic agent-execution seam.
 *
 * The graph walker dispatches each node through an `AgentRunner`, independent of
 * *which* backend actually runs the agent. Today there are two implementations:
 *
 *   - `VegaAgentRunner`      — LaunchDarkly's hosted Vega agent-dispatch (see
 *                              vegaClient.ts / vegaTransport.ts; unchanged).
 *   - `AnthropicAgentRunner` — runs the graph locally against the Anthropic API,
 *                              using each AI config's instructions as the agent
 *                              system prompt (see ./anthropic/).
 *
 * Selection is a runtime decision driven by the `auto-factory-ai-provider`
 * LaunchDarkly flag (see providerFlag.ts). The neutral types below are
 * structurally compatible with the Vega result shape so the Vega path is a thin
 * adapter and the walker code is identical for every provider.
 */

import type { LDAIConfigTracker } from "@launchdarkly/server-sdk-ai";

export type AgentStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "cancelled";

export interface AgentMessage {
  role: string;
  content: string;
  /** True for the message that represents the node's final output. */
  isFinal?: boolean;
}

export interface AgentNodeRequest {
  /** AI Config key for the agent/node to run (e.g. "autofactory-research-planner"). */
  configKey: string;
  /** Rendered prompt for this node (PR context + prior step output). */
  prompt: string;
  /**
   * Resolved + interpolated agent instructions from the LaunchDarkly AI config
   * (the agent's system prompt). The Anthropic path uses this; Vega ignores it
   * (it resolves the config server-side from `configKey`).
   */
  instructions?: string;
  /** Resolved model id from the AI config (Anthropic path). */
  model?: string;
  /**
   * Resolved model parameters from the LaunchDarkly AI config (`model.parameters`,
   * e.g. `{ temperature, maxTokens }`). Carried so a provider can honor the
   * LD-authored generation settings instead of hardcoding them. The Cursor path
   * maps these onto the selected Cursor model's parameter ids where they line up;
   * the Anthropic/Vega paths currently ignore it.
   */
  modelParameters?: Record<string, unknown>;
  /** Free-form context vars (PR number/title/body, prior output, …). */
  context?: Record<string, unknown>;
  /** Optional cap on agent turns (from a graph edge handoff). */
  maxTurns?: number;
  /** Per-edge request type (e.g. "Fix"). Drives the Vega built-in persona; informational for Anthropic. */
  requestType?: string;
  /**
   * Tool capabilities granted to this node, from the inbound graph edge's handoff
   * `capabilities` array (e.g. ["create_flag", "edit_files"]). When undefined, the
   * runner falls back to its built-in per-config-key defaults. Lets "which agent can
   * write" live in config (the graph), not hardcoded keys in the runner.
   */
  capabilities?: string[];
  /**
   * Tool definitions attached to this node's AI Config variation in
   * LaunchDarkly (the AI SDK's `config.tools` map). They shape the
   * model-facing interface — restricting the offered set and overriding
   * descriptions/schemas — within the ceiling set by `capabilities`; execution
   * and write-gating always stay in the runner's sandbox. Absent = the
   * built-in tool definitions (pre-tools projects keep working).
   */
  ldTools?: Record<string, { name?: string; description?: string; parameters?: Record<string, unknown> }>;
  /**
   * Per-node AI-config tracker. The runner records generation metrics
   * (duration, tokens, success/error) so they flow to LaunchDarkly's AI Config
   * monitoring dashboards, correlated to this graph run.
   */
  tracker?: LDAIConfigTracker;
}

export interface AgentNodeResult {
  status: AgentStatus;
  /** Agent messages; the final assistant message is the node's output. */
  messages: AgentMessage[];
  /** Tags the agent set — drive graph edge conditions (skip_if/require). */
  tags: Record<string, string>;
}

/** A backend that can run a single agent node to completion. */
export interface AgentRunner {
  runNode(req: AgentNodeRequest): Promise<AgentNodeResult>;
}
