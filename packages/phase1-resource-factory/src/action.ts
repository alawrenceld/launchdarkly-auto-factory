#!/usr/bin/env node
/**
 * Phase 1 GitHub Action entrypoint. Triggered on PR open/synchronize (no label
 * gate). Built natively on LaunchDarkly: the server SDK evaluates the AI-provider
 * flag, and the AI SDK resolves the agent graph + per-node agent configs. It
 * assembles PR context, walks the graph through the selected provider (Anthropic
 * locally, or Vega), then applies the approval decision.
 */

import { resolve } from "node:path";
import {
  type AgentRunner,
  AnthropicAgentRunner,
  GraphQLVegaTransport,
  LdClient,
  LdResourceWriter,
  type StallInfo,
  StubVegaTransport,
  VegaAgentRunner,
  VegaClient,
  type VegaTransport,
  appConnection,
  closeLdSdk,
  decideApproval,
  getApprovalMode,
  getLdSdk,
  interpretWalk,
  pipelineContext,
  resolveAiProvider,
  walkGraph,
} from "@auto-factory/shared";
import { postPrComment } from "./comment.js";
import { type PrContext, assemblePrContext } from "./prContext.js";

/**
 * Use the real GraphQL transport when VEGA_ENDPOINT + VEGA_TOKEN are set; else
 * fall back to the stub (no agent execution). Endpoint/auth are env-configured —
 * the dispatch host and auth header name are deployment-specific.
 */
function createVegaClient(): VegaClient {
  const endpoint = process.env.VEGA_ENDPOINT;
  // Auth is a regular LaunchDarkly API key — reuse LD_API_KEY unless overridden.
  const token = process.env.VEGA_TOKEN ?? process.env.LD_API_KEY;
  if (endpoint && token) {
    const transport: VegaTransport = new GraphQLVegaTransport({
      endpoint,
      token,
      ...(process.env.VEGA_AUTH_HEADER ? { authHeaderName: process.env.VEGA_AUTH_HEADER } : {}),
      ...(process.env.VEGA_REQUEST_TYPE ? { requestType: process.env.VEGA_REQUEST_TYPE } : {}),
      ...(process.env.GITHUB_REPOSITORY ? { repositories: [process.env.GITHUB_REPOSITORY] } : {}),
      // Dispatch's `project_slug` is the internal LD project ID — prefer LD_PROJECT_SLUG,
      // fall back to the human project key only if the slug isn't provided.
      ...(process.env.LD_PROJECT_SLUG ?? process.env.LD_PROJECT_KEY
        ? { projectSlug: process.env.LD_PROJECT_SLUG ?? process.env.LD_PROJECT_KEY }
        : {}),
    });
    return new VegaClient(transport);
  }
  console.log("VEGA_ENDPOINT/VEGA_TOKEN not set — using stub transport (no agent execution).");
  return new VegaClient(new StubVegaTransport());
}

/**
 * Build the agent runner for the provider the LaunchDarkly flag selects.
 * The Vega path dispatches to LaunchDarkly's hosted runtime; the Anthropic path
 * runs the graph locally with sandbox tools (see shared/anthropic/).
 *
 * Flag creation is enabled (real `create_flag` against the app project) when
 * ENABLE_FLAG_CREATION=true and an api- key is present; otherwise read-only.
 */
function createAgentRunner(provider: string): AgentRunner {
  if (provider === "vega") {
    return new VegaAgentRunner(createVegaClient());
  }
  // Anthropic (default): sandbox root is the repo the agents inspect. Locally this
  // is the bundled demo app; in CI it defaults to the checked-out workspace.
  const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "examples/demo-app");
  const writer = flagCreationWriter();
  const codeChangesEnabled = process.env.ENABLE_CODE_CHANGES === "true";
  console.log(`Flag creation: ${writer ? `ENABLED → app project '${writer.projectKey}'` : "disabled"}.`);
  console.log(`Code changes (edit + commit/push): ${codeChangesEnabled ? "ENABLED" : "disabled"}.`);
  return new AnthropicAgentRunner({
    sandboxRoot,
    codeChangesEnabled,
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
    ...(writer ? { writer } : {}),
    ...(process.env.PR_BRANCH ? { prBranch: process.env.PR_BRANCH } : {}),
    ...(process.env.PR_BASE_REF ? { prBaseRef: process.env.PR_BASE_REF } : {}),
  });
}

/** A writer for real flag creation in the app project, or undefined for read-only. */
function flagCreationWriter(): LdResourceWriter | undefined {
  if (process.env.ENABLE_FLAG_CREATION !== "true") return undefined;
  if (!process.env.LD_API_KEY) {
    throw new Error("ENABLE_FLAG_CREATION=true but LD_API_KEY is not set");
  }
  // Refuse to create flags in the factory/control-plane project: require an
  // explicit app project so we never pollute the project holding the AI configs.
  if (!process.env.LD_APP_PROJECT_KEY) {
    throw new Error(
      "ENABLE_FLAG_CREATION=true but LD_APP_PROJECT_KEY is not set — refusing to create flags in the factory project",
    );
  }
  return new LdResourceWriter(new LdClient(appConnection()));
}

/**
 * Human-readable description of a chain stall (unmet handoff) for logs, the GH
 * annotation, and the PR comment.
 */
function describeStall(stall: StallInfo): string {
  const edges = stall.unmet
    .map((u) => `edge → ${u.target} requires ${Object.entries(u.requireMissing).map(([k, v]) => `${k}=${v}`).join(", ")} (never produced)`)
    .join("; ");
  return `chain stalled at '${stall.node}'; ${edges}. Downstream agents did not run.`;
}

/**
 * Variables for AI-config instruction interpolation (done by LaunchDarkly's AI
 * SDK). Run-level values only; per-step output flows through the node prompt.
 * LAUNCHDARKLY_PROJECT points at the data-plane app project where flags are created.
 */
function buildVariables(ctx: PrContext): Record<string, unknown> {
  return {
    PR_NUMBER: ctx.PR_NUMBER ?? "",
    PR_TITLE: ctx.PR_TITLE ?? "",
    PR_BODY: ctx.PR_BODY ?? "",
    REPO: ctx.REPO ?? "",
    PR_BRANCH: process.env.PR_BRANCH ?? "",
    TICKET_ID: process.env.TICKET_ID ?? "",
    LAUNCHDARKLY_PROJECT: process.env.LD_APP_PROJECT_KEY ?? "autofactory-demo",
  };
}

/** GitHub Actions exposes `with:` inputs as INPUT_<NAME>. Map them to the plain
 *  env vars the rest of the code reads. */
function mapActionInputs(): void {
  const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`];
  const set = (envName: string, inputName: string) => {
    const v = input(inputName);
    if (v && !process.env[envName]) process.env[envName] = v;
  };
  set("LD_SDK_KEY", "ld_sdk_key");
  set("ANTHROPIC_API_KEY", "anthropic_api_key");
  set("LD_API_KEY", "ld_api_key");
  set("LD_BASE_URL", "ld_base_url");
  set("LD_PROJECT_KEY", "ld_project_key");
  set("LD_PROJECT_SLUG", "ld_project_slug");
  set("LD_APP_PROJECT_KEY", "ld_app_project_key");
  set("GRAPH_KEY", "graph_key");
  set("SANDBOX_ROOT", "sandbox_root");
  set("ENABLE_FLAG_CREATION", "enable_flag_creation");
  set("ENABLE_CODE_CHANGES", "enable_code_changes");
  set("PR_BRANCH", "pr_branch");
  set("PR_BASE_REF", "pr_base");
  set("APPROVAL_MODE", "approval_mode");
  set("GITHUB_TOKEN", "github_token");
  set("VEGA_ENDPOINT", "vega_endpoint");
  set("VEGA_TOKEN", "vega_token");
  set("VEGA_AUTH_HEADER", "vega_auth_header");
  set("VEGA_REQUEST_TYPE", "vega_request_type");
}

async function main(): Promise<void> {
  mapActionInputs();
  const context = assemblePrContext();

  // Native LaunchDarkly: server SDK (flag eval) + AI SDK (graph + agent configs).
  const { ldClient, aiClient } = await getLdSdk();
  const ldContext = pipelineContext();

  const provider = await resolveAiProvider(ldClient, ldContext);
  const graphKey = process.env.GRAPH_KEY ?? "gha-auto-factory";
  const graphDef = await aiClient.agentGraph(graphKey, ldContext, buildVariables(context));
  if (!graphDef.enabled) {
    throw new Error(`Agent graph '${graphKey}' is disabled or unavailable in LaunchDarkly`);
  }
  const graphTracker = graphDef.createTracker();

  console.log(`Phase 1: PR #${context.PR_NUMBER ?? "?"} → graph '${graphKey}' [provider: ${provider}]`);

  const runner = createAgentRunner(provider);
  const walk = await walkGraph(graphDef, runner, context, graphTracker);

  // Per-node visibility: dump each agent's terminal status, routing tags, and final output.
  for (const r of walk.runs) {
    console.log(`\n════════ ${r.configKey} [${r.status}] ════════`);
    console.log(`tags: ${JSON.stringify(r.tags)}`);
    console.log((r.output || "(no output)").slice(0, 4000));
  }
  console.log("\n──────── walk summary ────────");

  console.log(`Ran ${walk.runs.length} node(s): ${walk.runs.map((r) => r.configKey).join(" → ")}`);
  if (walk.skipped.length) console.log(`Skipped: ${walk.skipped.join(", ")}`);

  // Make a stall observable: when the chain stops on an unmet handoff (a required
  // routing tag was never produced) rather than at a terminal node, say so loudly
  // — as a GitHub Actions warning annotation and in the PR comment — instead of
  // letting it surface only as a misleading verdict (issue #9 item #3).
  const stallText = walk.stalledAt ? describeStall(walk.stalledAt) : "";
  if (stallText) console.log(`::warning::AutoFactory: ${stallText}`);

  const { reviewApproved, risk, skipFlagging } = interpretWalk(walk.tags);
  const mode = getApprovalMode();
  const decision = decideApproval(mode, reviewApproved, risk, skipFlagging);

  console.log(`Approval [${mode}] → ${decision.reason}`);
  if (decision.requiresHuman) {
    console.log("⏸ Human approval required — not auto-applied.");
  } else if (decision.apply) {
    console.log("✓ Changes approved and applied by the agents.");
  } else if (decision.noop) {
    console.log("• No flag needed — nothing to apply.");
  } else {
    console.log("✗ Not applied.");
  }

  const summary = [
    "### LaunchDarkly Auto-Factory — Phase 1",
    "",
    `**Agents:** ${walk.runs.map((r) => r.configKey).join(" → ") || "(none ran)"}`,
    walk.skipped.length ? `**Skipped:** ${walk.skipped.join(", ")}` : "",
    stallText ? `**⚠ Stalled:** ${stallText}` : "",
    "",
    `**Approval (${mode}):** ${decision.reason}`,
  ]
    .filter(Boolean)
    .join("\n");
  await postPrComment(summary, { prNumber: context.PR_NUMBER, repo: context.REPO });

  // Non-zero exit signals the PR check should fail (genuine rejection only). A
  // no-op (no flag needed) and a human-approval pause both leave the check green.
  if (!decision.apply && !decision.requiresHuman && !decision.noop) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    // Close the SDK so the event loop drains and the process exits (use
    // exitCode above, not process.exit, so this still runs).
    .finally(() => closeLdSdk());
}
