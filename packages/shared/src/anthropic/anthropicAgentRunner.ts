/**
 * Anthropic implementation of the `AgentRunner` seam.
 *
 * Runs the AutoFactory agent graph LOCALLY. The agent's instructions and model
 * are resolved NATIVELY by the LaunchDarkly AI SDK (the graph walker passes the
 * already-interpolated `instructions`, `model`, and a per-node `tracker` from the
 * `LDAIAgentConfig`). This runner just executes: it drives an Anthropic tool-use
 * loop with a read-only sandbox tool set (see sandboxTools.ts) and records
 * generation metrics to LaunchDarkly via the tracker.
 *
 * This is the piece Vega's `agentDispatch` does NOT do — Vega runs built-in
 * personas and ignores the AI config's instructions. Here the LD-authored
 * instructions ARE the agent.
 *
 * Sandbox / dry-run: the agents cannot write to LaunchDarkly, git, or the repo.
 * They inspect the code and emit routing tags via `tag_conversation`, which is
 * what the graph walker needs to advance the chain. Promote to write tools (LD
 * flag creation, git) for in-pipeline runs without touching the walker.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentNodeRequest, AgentNodeResult, AgentRunner, AgentStatus } from "../agentRunner.js";
import { SpanKind, SpanStatusCode, aiTracer, setGenAiAttributes } from "../observability.js";
import type { KnowledgeGraph } from "../graph/schema.js";
import type { LdResourceWriter } from "./ldWriter.js";
import { type GitMode, SandboxToolExecutor, type ToolCapabilities, buildSandboxTools } from "./sandboxTools.js";

const TAGGING_NOTE = `

You MUST call \`tag_conversation\` with the routing tag(s) your instructions specify
(e.g. flag_created, skip_flagging, flag_worthy, needs_tests, review_approved,
risk_level). The downstream chain advances on these tags — a step that sets no tags
stalls the pipeline.`;

/**
 * Build the execution-mode note appended to the agent's instructions, per
 * capabilities. Exported so every provider (Anthropic, Cursor) appends the SAME
 * capability + tagging guidance — the agents must behave identically across
 * providers so only the model brain differs, not the instructions.
 */
export function modeNote(caps: ToolCapabilities): string {
  const lines = [
    "\n\n---\n## EXECUTION MODE",
    "You have read-only repo tools (`read_file`, `list_dir`, `grep`).",
  ];
  if (caps.queryGraph) {
    lines.push(
      "You have `query_dependencies` — the estate's knowledge graph (service call edges observed from LaunchDarkly telemetry + flag→code wrap points). Call it with NO arguments EARLY to get this PR's blast radius (changed services, dependent services at risk, upstream contracts, flags already on the changed code) and let it inform your classification and risk_score. Treat any entry in its `gaps` list as UNKNOWN coverage — a thin graph is never evidence of low impact.",
    );
  }
  if (caps.createFlag) {
    lines.push(
      "You have `create_flag` — creates a REAL boolean flag in the LaunchDarkly app project (idempotent; safe on PR re-runs). When your rules say a flag is needed, CALL it.",
    );
  }
  if (caps.createMetric) {
    lines.push(
      "You have `create_metric` — creates a REAL guarded-release metric in the LaunchDarkly app project (idempotent). To make a metric measurable you must FIRST instrument its event in code: add a LaunchDarkly `track(event_key, …)` call on the path the flag wraps (via `edit_file`), then call `create_metric` with the matching `event_key`. Creating the metric before signals flow is expected.",
    );
  }
  if (caps.writeManifest || caps.stewardManifest) {
    lines.push(
      caps.stewardManifest
        ? "You have `write_manifest` (STEWARD grade): you may create/update the release manifest INCLUDING an existing `releaseIntent` — you are the only agent allowed to touch a human's intent, and only to normalize/structure it, never to broaden it (e.g. never flip hold→auto)."
        : "You have `write_manifest` — create/update the release manifest (.release-flags/pr-<N>.json) by passing only the fields you own (flagKey, scope, releasePlan.*). It merges, auto-initializes the human-editable `releaseIntent` skeleton, PRESERVES any existing intent, and commits automatically. Never write manifests with other tools.",
    );
  }
  if (caps.editFiles) {
    lines.push(
      "You have `write_file`, `edit_file`, `run_tests`, and `commit_and_push`. EXECUTE your job for real: make the file changes your instructions describe (e.g. wire the flag into the code, or add the test file). If you wrote or changed tests, call `run_tests` to confirm they pass and FIX any failures before committing. Then call `commit_and_push` ONCE to land your changes on the PR branch. Match the existing code patterns you find.",
    );
  } else {
    lines.push("You CANNOT edit files or push commits — describe what you would change and tag accordingly.");
  }
  lines.push("Keep exploration focused, then finish with a short brief for the next agent.");
  return lines.join("\n") + TAGGING_NOTE;
}

const DEFAULT_MAX_TURNS = 12;
const MAX_TOKENS = 4096;
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * FALLBACK per-node capability grants, used only when the graph edge doesn't
 * declare a `capabilities` array (see `resolveGrant`). Prefer putting grants on
 * the graph edges so "which agent can write" is config, not code — this map is a
 * safety net for graphs that predate that and is keyed by config key (so it
 * silently misses renamed agents; the per-node log makes that diagnosable).
 */
const NODE_CAPABILITIES: Record<string, ToolCapabilities> = {
  // ROOT node: edges can't grant capabilities to it (grants ride inbound
  // handoffs), so the research planner's narrow manifest-write power lives here.
  // queryGraph: the planner's blast-radius input (ADR 0010) — only offered when
  // a graph was actually composed for the run (the KG flag gates that upstream).
  "autofactory-research-planner": { createFlag: false, createMetric: false, editFiles: false, writeManifest: true, queryGraph: true },
  // The steward normalizes the human-edited releaseIntent — the only node that
  // may UPDATE an existing intent block.
  "autofactory-manifest-steward": { createFlag: false, createMetric: false, editFiles: false, stewardManifest: true },
  "autofactory-flag-implementer": { createFlag: true, createMetric: false, editFiles: true, writeManifest: true },
  "autofactory-flag-testing": { createFlag: false, createMetric: false, editFiles: true },
  // The metrics author creates LD metrics and instruments the event (track()) that
  // feeds them — so it needs create_metric AND edit_files (+ manifest updates).
  "autofactory-metrics-author": { createFlag: false, createMetric: true, editFiles: true, writeManifest: true },
};

/**
 * Routing tags each node MUST emit for the chain to advance, keyed by config
 * key. These are the deterministic ones (a node's own decision / hand-off) — NOT
 * the conditional ones (e.g. `skip_flagging`, set only when no flag is needed)
 * nor the tool-auto ones (`flag_created`/`metric_keys`, set by create_flag/
 * create_metric). If the agent finishes without these, the runner forces a final
 * `tag_conversation` call (see `runNode`) so a node can never silently stall the
 * chain or yield a misleading verdict (issue #9, failure modes #1 and #2). The
 * graph side is guarded separately by `npm run check:configs`.
 */
export const NODE_REQUIRED_TAGS: Record<string, string[]> = {
  // Always decides flag-worthiness AND a numeric risk score — risk-threshold
  // gates fail closed when risk_score is missing, so force it.
  "autofactory-research-planner": ["flag_worthy", "risk_score"],
  "autofactory-metrics-author": ["needs_tests"], // always hands off to testing
  "autofactory-code-reviewer": ["review_approved"], // always produces a verdict
};

/** The required routing tags this node hasn't emitted yet (empty if all present). */
export function missingRequiredTags(configKey: string, tags: Record<string, string>): string[] {
  return (NODE_REQUIRED_TAGS[configKey] ?? []).filter((t) => !(t in tags));
}

/** Capability tokens recognized on a graph edge's `capabilities` array. */
export const CAP_CREATE_FLAG = "create_flag";
export const CAP_CREATE_METRIC = "create_metric";
export const CAP_EDIT_FILES = "edit_files";
export const CAP_WRITE_MANIFEST = "write_manifest";
export const CAP_STEWARD_MANIFEST = "steward_manifest";
export const CAP_QUERY_GRAPH = "query_graph";

/**
 * Resolve a node's requested capability grant: from the edge `capabilities` list
 * when present, else the `NODE_CAPABILITIES` fallback, else read-only. Returns the
 * grant + its source for logging (NOT yet intersected with what's globally enabled).
 */
export function resolveGrant(
  configKey: string,
  capabilities: string[] | undefined,
): { grant: ToolCapabilities; source: "edge" | "fallback" | "none" } {
  if (capabilities) {
    return {
      grant: {
        createFlag: capabilities.includes(CAP_CREATE_FLAG),
        createMetric: capabilities.includes(CAP_CREATE_METRIC),
        editFiles: capabilities.includes(CAP_EDIT_FILES),
        writeManifest: capabilities.includes(CAP_WRITE_MANIFEST),
        stewardManifest: capabilities.includes(CAP_STEWARD_MANIFEST),
        queryGraph: capabilities.includes(CAP_QUERY_GRAPH),
      },
      source: "edge",
    };
  }
  const fallback = NODE_CAPABILITIES[configKey];
  if (fallback) return { grant: fallback, source: "fallback" };
  return { grant: { createFlag: false, createMetric: false, editFiles: false }, source: "none" };
}

export interface AnthropicAgentRunnerOptions {
  /** Absolute path the sandbox tools operate within (the repo under review / the checkout). */
  sandboxRoot: string;
  /** Anthropic API key; falls back to ANTHROPIC_API_KEY in the env. */
  apiKey?: string;
  /** When provided, `create_flag` is enabled for capable nodes (real flags in the app project). */
  writer?: LdResourceWriter;
  /** When true, file-edit + commit/push tools are enabled for capable nodes. */
  codeChangesEnabled?: boolean;
  /** PR head branch the git tools push to (passed to the sandbox executor). */
  prBranch?: string;
  /** PR base ref the git_diff tool diffs against (passed to the sandbox executor). */
  prBaseRef?: string;
  /**
   * How `commit_and_push` finalizes edits: "push" (default, GitHub Action) or
   * "workingTree" (Cursor extension — leave edits uncommitted for review).
   */
  gitMode?: GitMode;
  /**
   * Composed knowledge graph for this run (ADR 0010). Presence is the global
   * enable for `query_dependencies`: the front end only composes a graph when
   * the `auto-factory-knowledge-graph` flag serves true, so a granted node on
   * a flag-off run simply doesn't get the tool.
   */
  knowledgeGraph?: KnowledgeGraph;
  /** Repo-relative files changed in this PR (blast-radius input). */
  changedFiles?: string[];
}

export class AnthropicAgentRunner implements AgentRunner {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicAgentRunnerOptions) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    // Effective capabilities = this node's grant ∩ globally-enabled features.
    const { grant, source } = resolveGrant(req.configKey, req.capabilities);
    const caps: ToolCapabilities = {
      createFlag: grant.createFlag && this.opts.writer !== undefined,
      createMetric: grant.createMetric && this.opts.writer !== undefined,
      editFiles: grant.editFiles && this.opts.codeChangesEnabled === true,
      // Manifest writes are code changes — same global toggle as editFiles.
      writeManifest: grant.writeManifest === true && this.opts.codeChangesEnabled === true,
      stewardManifest: grant.stewardManifest === true && this.opts.codeChangesEnabled === true,
      // Read-only; globally enabled by the presence of a composed graph (KG flag).
      queryGraph: grant.queryGraph === true && this.opts.knowledgeGraph !== undefined,
    };
    // Per-node diagnostic: makes a renamed/added agent that silently lost its
    // grant (source "none", read-only) visible in the run logs.
    console.log(
      `[node] ${req.configKey} grant(${source}): createFlag=${grant.createFlag} createMetric=${grant.createMetric} editFiles=${grant.editFiles} → effective createFlag=${caps.createFlag} createMetric=${caps.createMetric} editFiles=${caps.editFiles}`,
    );
    const writer = caps.createFlag || caps.createMetric ? this.opts.writer : undefined;

    const system = (req.instructions ?? "") + modeNote(caps);
    const model = anthropicModelId(req.model);
    const executor = new SandboxToolExecutor(
      this.opts.sandboxRoot,
      writer,
      caps.editFiles,
      this.opts.prBranch,
      this.opts.prBaseRef,
      this.opts.gitMode ?? "push",
      caps.writeManifest === true && this.opts.codeChangesEnabled === true,
      caps.stewardManifest === true && this.opts.codeChangesEnabled === true,
    );
    if (caps.queryGraph && this.opts.knowledgeGraph) {
      executor.provideKnowledgeGraph(this.opts.knowledgeGraph, this.opts.changedFiles ?? []);
    }
    const tools = buildSandboxTools(caps) as Anthropic.Tool[];
    const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.prompt }];
    let finalText = "";
    let status: AgentStatus = "completed";
    let inputTokens = 0;
    let outputTokens = 0;
    const started = Date.now();

    // Emit a gen_ai span for LD LLM Observability (parity with the Cursor runner),
    // so every provider's agent runs show up in LLM Observability, not just Cursor.
    // No-op tracer when observability isn't enabled.
    const span = aiTracer().startSpan(`chat ${req.configKey}`, { kind: SpanKind.CLIENT });

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const resp = await this.client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools,
          messages,
        });
        inputTokens += resp.usage.input_tokens;
        outputTokens += resp.usage.output_tokens;
        messages.push({ role: "assistant", content: resp.content });
        finalText = textOf(resp.content) || finalText;

        if (resp.stop_reason !== "tool_use") break;

        const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of toolUses) {
          const r = await executor.execute(b.name, (b.input ?? {}) as Record<string, unknown>);
          results.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });

        if (turn === maxTurns - 1) status = "stopped"; // hit the turn cap mid-task
      }

      // Safety net: if the agent finished without recording the routing tag(s)
      // its node owns, force one `tag_conversation` call so the chain can't
      // silently stall or report a misleading verdict (issue #9). Best-effort —
      // a failure here doesn't fail the node.
      const missing = missingRequiredTags(req.configKey, executor.tags);
      if (missing.length > 0) {
        try {
          const forcePrompt =
            `Before finishing you MUST record your routing decision. You have not set the required tag(s): ${missing.join(", ")}. ` +
            "Call `tag_conversation` now with a `tags` object, choosing the correct value(s) per your instructions " +
            "(e.g. your flag-worthiness decision, the testing hand-off, or your APPROVE/REJECT verdict and risk level).";
          messages.push({ role: "user", content: forcePrompt });
          const forced = await this.client.messages.create({
            model,
            max_tokens: MAX_TOKENS,
            system,
            tools,
            messages,
            tool_choice: { type: "tool", name: "tag_conversation" },
          });
          inputTokens += forced.usage.input_tokens;
          outputTokens += forced.usage.output_tokens;
          for (const b of forced.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use")) {
            await executor.execute(b.name, (b.input ?? {}) as Record<string, unknown>);
          }
          const stillMissing = missingRequiredTags(req.configKey, executor.tags);
          console.log(
            `[node] ${req.configKey} forced tag_conversation for missing [${missing.join(", ")}] → now ${
              stillMissing.length ? `still missing [${stillMissing.join(", ")}]` : "all present"
            }`,
          );
        } catch (e) {
          console.warn(`[node] ${req.configKey} forced tag call failed (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
      }
      req.tracker?.trackSuccess();
    } catch (e) {
      status = "failed";
      finalText = e instanceof Error ? e.message : String(e);
      req.tracker?.trackError();
      if (e instanceof Error) span.recordException(e);
    } finally {
      req.tracker?.trackDuration(Date.now() - started);
      if (inputTokens || outputTokens) {
        req.tracker?.trackTokens({ input: inputTokens, output: outputTokens, total: inputTokens + outputTokens });
      }
      // Record the gen_ai attributes + status on the observability span, then end it.
      setGenAiAttributes(span, {
        provider: "anthropic",
        requestModel: model,
        ...(req.tracker ? { tracker: req.tracker } : {}),
        prompt: req.prompt,
        output: finalText,
        ...(inputTokens || outputTokens
          ? { usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens } }
          : {}),
      });
      span.setStatus({ code: status === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.end();
    }

    return {
      status,
      messages: [{ role: "assistant", content: finalText, isFinal: true }],
      tags: { ...executor.tags },
    };
  }
}

/** Concatenate the text blocks of an Anthropic response. */
function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Map a LaunchDarkly model name to an Anthropic model id. LD model names may be
 * provider-qualified (e.g. "Anthropic.claude-sonnet-4-6") or Bedrock-style
 * region-qualified (e.g. "us.anthropic.claude-sonnet-4-6-v1:0"). Strip at most an
 * optional leading region segment and a single "anthropic." prefix; everything
 * else (including multi-dot model ids like "...-v1:0") passes through unchanged.
 */
export function anthropicModelId(name: string | undefined): string {
  if (!name) return DEFAULT_MODEL;
  const id = name
    .trim()
    .replace(/^[a-z]{2}\./i, "") // optional region segment, e.g. "us."
    .replace(/^anthropic\./i, ""); // single provider prefix
  return id.trim() || DEFAULT_MODEL;
}
