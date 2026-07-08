#!/usr/bin/env node
/**
 * Phase 1 GitHub Action entrypoint. Triggered on PR open/synchronize (no label
 * gate). Built natively on LaunchDarkly: the server SDK evaluates the AI-provider
 * flag, and the AI SDK resolves the agent graph + per-node agent configs. It
 * assembles PR context, walks the graph through the selected provider (Anthropic
 * locally, or Vega), then applies the approval decision.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  type AgentRunner,
  AnthropicAgentRunner,
  CursorAgentRunner,
  GraphQLVegaTransport,
  type JudgeCompletion,
  type JudgeHook,
  createAnthropicJudgeCompletion,
  createCursorJudgeCompletion,
  createGitDiffEvidence,
  createJudgeHook,
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
  type GateController,
  getApprovalMode,
  getLdSdk,
  interpretWalk,
  pipelineContext,
  resolveAiProvider,
  resolveApprovalGates,
  walkGraph,
} from "@auto-factory/shared";
import { postCheckRun } from "./checkRun.js";
import { postPrComment } from "./comment.js";
import { approveLabel, ensureLabel, fetchApprovedSteps } from "./labels.js";
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
 * The Vega path dispatches to LaunchDarkly's hosted runtime; the Anthropic and
 * Cursor paths run the deterministic graph locally with the SAME sandbox tools
 * (see shared/anthropic/ and shared/cursor/) — only the model brain differs.
 *
 * Flag creation is enabled (real `create_flag` against the app project) when
 * ENABLE_FLAG_CREATION=true and an api- key is present; otherwise read-only.
 */
function createAgentRunner(provider: string): AgentRunner {
  if (provider === "vega") {
    return new VegaAgentRunner(createVegaClient());
  }

  // Local-execution providers (Anthropic default, or Cursor): sandbox root is the
  // repo the agents inspect. Locally this is the bundled demo app; in CI it
  // defaults to the checked-out workspace. Both share these options.
  const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "examples/demo-app");
  const writer = flagCreationWriter();
  const codeChangesEnabled = process.env.ENABLE_CODE_CHANGES === "true";
  console.log(`Flag creation: ${writer ? `ENABLED → app project '${writer.projectKey}'` : "disabled"}.`);
  console.log(`Code changes (edit + commit/push): ${codeChangesEnabled ? "ENABLED" : "disabled"}.`);
  const localOpts = {
    sandboxRoot,
    codeChangesEnabled,
    ...(writer ? { writer } : {}),
    ...(process.env.PR_BRANCH ? { prBranch: process.env.PR_BRANCH } : {}),
    ...(process.env.PR_BASE_REF ? { prBaseRef: process.env.PR_BASE_REF } : {}),
  };

  if (provider === "cursor") {
    // Cursor agents via @cursor/sdk. Model + parameters are mapped from the LD AI
    // config (see shared/cursor/cursorModel.ts); inference runs on Cursor's hosted
    // models. CURSOR_MODEL is the fallback when an LD model has no Cursor match.
    return new CursorAgentRunner({
      ...localOpts,
      ...(process.env.CURSOR_API_KEY ? { apiKey: process.env.CURSOR_API_KEY } : {}),
      ...(process.env.CURSOR_MODEL ? { model: process.env.CURSOR_MODEL } : {}),
    });
  }

  // Anthropic (default).
  return new AnthropicAgentRunner({
    ...localOpts,
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  });
}

/**
 * The provider-matched completion that executes attached LaunchDarkly judges
 * (see shared/judges.ts). Vega has no local judge execution — judges are skipped
 * there with a log note.
 */
function createJudgeCompletion(provider: string): JudgeCompletion | undefined {
  if (provider === "cursor") {
    return createCursorJudgeCompletion({
      ...(process.env.CURSOR_API_KEY ? { apiKey: process.env.CURSOR_API_KEY } : {}),
      ...(process.env.CURSOR_MODEL ? { model: process.env.CURSOR_MODEL } : {}),
    });
  }
  if (provider === "anthropic") {
    return createAnthropicJudgeCompletion(process.env.ANTHROPIC_API_KEY);
  }
  console.log(`Judges: no local judge execution on provider '${provider}' — attached judges are skipped.`);
  return undefined;
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
 * HEAD of the checkout after the chain ran. The agents push commits with
 * [skip ci], which moves the PR head PAST the workflow's own check — so the
 * final verdict check run must attach to this SHA to be visible on the PR's
 * latest commit. Falls back to undefined (caller uses the event's head SHA).
 */
function checkoutHeadSha(root: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
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
 * Status-board PR comment when the chain halts at an approval gate: lists every
 * gated step with its state (✓ approved / ⏸ awaiting now / ⬜ gated, later), and
 * the exact label to add to proceed. This is the human-readable view; the label
 * chips are the at-a-glance approved state.
 */
function buildGateComment(gatedSteps: string[], approved: Set<string>, pendingNode: string): string {
  const lines = gatedSteps.map((step) => {
    if (approved.has(step)) return `- ✓ \`${step}\` — approved`;
    if (step === pendingNode) return `- ⏸ \`${step}\` — **awaiting approval**: add the label \`${approveLabel(step)}\``;
    return `- ⬜ \`${step}\` — gated (after the step above)`;
  });
  return [
    "### LaunchDarkly Auto-Factory — Phase 1 ⏸ awaiting approval",
    "",
    `The chain paused before **${pendingNode}**. Nothing was created for this or later steps yet.`,
    "Approve by adding the labeled step below; the chain resumes on the next run.",
    "",
    ...lines,
  ].join("\n");
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
  set("CURSOR_API_KEY", "cursor_api_key");
  set("CURSOR_MODEL", "cursor_model");
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
    throw new Error(
      `Agent graph '${graphKey}' is disabled or unavailable in LaunchDarkly. ` +
        `Most common cause: LD_SDK_KEY is not the FACTORY project's server SDK key — it must be for ` +
        `the project holding the AI configs, agent graph, and operational flags (LD_PROJECT_KEY='${process.env.LD_PROJECT_KEY ?? "?"}'), ` +
        `NOT the app project where flags get created. Also check GRAPH_KEY and that the graph is enabled in this environment.`,
    );
  }
  const graphTracker = graphDef.createTracker();

  console.log(`Phase 1: PR #${context.PR_NUMBER ?? "?"} → graph '${graphKey}' [provider: ${provider}]`);

  const runner = createAgentRunner(provider);

  // Per-step approval gates (independent of APPROVAL_MODE). Gated agent node
  // keys come from the auto-factory-approval-gates flag; a gate is satisfied by
  // a PR label `af-approve:<nodeKey>`. The chain halts before a gated node until
  // its label is present (a re-run after the label is added proceeds).
  const gatedSteps = await resolveApprovalGates(ldClient, ldContext);
  let approvedSteps = new Set<string>();
  let gate: GateController | undefined;
  if (gatedSteps.length) {
    approvedSteps = await fetchApprovedSteps(context.REPO, context.PR_NUMBER, process.env.GITHUB_TOKEN);
    gate = { steps: gatedSteps, resolve: (node) => approvedSteps.has(node) };
    console.log(`Approval gates: [${gatedSteps.join(", ")}]; approved: [${[...approvedSteps].join(", ") || "none"}]`);
  }

  // Judges attached to agent configs in LaunchDarkly (e.g. implementation- and
  // metrics-quality judges) score node outputs 0..1; scores record per-variation
  // in AI Config monitoring — the quality dimension of the model A/B. Evidence:
  // each judged node's ACTUAL commits (node-scoped git diff of the checkout the
  // agents push to) so judges verify the agent's report rather than trust it.
  const sandboxRoot = resolve(process.env.SANDBOX_ROOT ?? "examples/demo-app");
  const judgeCompletion = createJudgeCompletion(provider);
  const baseJudgeHook = judgeCompletion
    ? createJudgeHook({
        aiClient,
        ldContext,
        variables: buildVariables(context),
        completion: judgeCompletion,
        evidence: createGitDiffEvidence(sandboxRoot),
      })
    : undefined;
  // Capture judge scores per node for the PR summary table.
  const judgeScores = new Map<string, number>();
  const judgeHook: JudgeHook | undefined = baseJudgeHook
    ? async (args) => {
        const results = await baseJudgeHook(args);
        for (const r of results) {
          if (r.sampled && typeof r.score === "number") judgeScores.set(args.configKey, r.score);
        }
        return results;
      }
    : undefined;

  const walk = await walkGraph(graphDef, runner, context, graphTracker, undefined, gate, judgeHook);

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

  // Halted at an approval gate: report what's pending + how to approve, then
  // stop. The flag/code for the gated step have NOT been created. A re-run once
  // the label is added proceeds past the gate.
  if (walk.pendingApproval) {
    const node = walk.pendingApproval.node;
    const label = approveLabel(node);
    await ensureLabel(context.REPO, label, process.env.GITHUB_TOKEN);
    console.log(`::warning::AutoFactory: awaiting approval before '${node}'. Add the PR label '${label}' to proceed.`);
    const summary = buildGateComment(gatedSteps, approvedSteps, node);
    await postPrComment(summary, { prNumber: context.PR_NUMBER, repo: context.REPO });
    // Carry the pause as a distinct `action_required` check run rather than a red
    // failure, so it doesn't read as a pipeline error or a reviewer rejection
    // (which also exit 1). The job itself exits 0 — the check run is the signal.
    await postCheckRun({
      repo: context.REPO,
      headSha: context.HEAD_SHA,
      conclusion: "action_required",
      title: `Approval required before ${node}`,
      summary: `The AutoFactory chain paused before \`${node}\`. Nothing was created for this or later steps. Add the PR label \`${label}\` to approve; the chain resumes on the next run.`,
    });
    return;
  }

  // Gates were configured and all cleared: post a `success` check under the same
  // name so it supersedes any earlier `action_required` on this head SHA.
  if (gatedSteps.length) {
    await postCheckRun({
      repo: context.REPO,
      headSha: context.HEAD_SHA,
      conclusion: "success",
      title: "Approval gates satisfied",
      summary: `Approved step(s): ${[...approvedSteps].join(", ") || "(none gated this run)"}. The chain proceeded past all gates.`,
    });
  }

  const verdict = interpretWalk(walk.tags);
  const mode = getApprovalMode();
  const decision = decideApproval(mode, verdict);

  console.log(`Approval [${mode}] → ${decision.reason}`);
  if (decision.requiresHuman) {
    console.log("⏸ Human approval required — not auto-applied.");
  } else if (decision.apply) {
    console.log("✓ Changes approved and applied by the agents.");
  } else if (decision.noop) {
    console.log("• No flag needed — nothing to apply.");
  } else if (decision.incomplete) {
    console.log("⚠ Incomplete — the chain did not complete a code review (see the stall above).");
  } else {
    console.log("✗ Not applied — code review REJECTED.");
  }

  // Per-agent results table: status, routing tags, and judge score (when a
  // LaunchDarkly judge evaluated the node). This is the at-a-glance record the
  // PR reader gets without opening the Actions log.
  const agentRows = walk.runs.map((r) => {
    const judge = judgeScores.get(r.configKey);
    const tags =
      Object.entries(r.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
        .slice(0, 140) || "—";
    return `| \`${r.configKey}\` | ${r.status} | ${judge !== undefined ? judge.toFixed(2) : "—"} | ${tags} |`;
  });
  const summary = [
    "### LaunchDarkly Auto-Factory — Phase 1",
    "",
    `**Approval (${mode}):** ${decision.reason}`,
    walk.skipped.length ? `**Skipped:** ${walk.skipped.join(", ")}` : "",
    stallText ? `**⚠ Stalled:** ${stallText}` : "",
    "",
    "| Agent | Status | Judge | Tags |",
    "|---|---|---|---|",
    ...(agentRows.length ? agentRows : ["| (none ran) | — | — | — |"]),
  ]
    .filter(Boolean)
    .join("\n");
  await postPrComment(summary, { prNumber: context.PR_NUMBER, repo: context.REPO });

  // Always post the verdict as a named check run, attached to the POST-chain
  // HEAD: the agents' [skip ci] commits move the PR head past the workflow's own
  // check, so without this the PR's latest commit shows no AutoFactory status.
  await postCheckRun({
    name: "AutoFactory — Phase 1",
    repo: context.REPO,
    headSha: checkoutHeadSha(sandboxRoot) ?? context.HEAD_SHA,
    conclusion: decision.apply || decision.noop ? "success" : decision.requiresHuman ? "action_required" : "failure",
    title: decision.reason,
    summary,
  });

  // Non-zero exit fails the PR check. Green: applied, human-approval pause, or a
  // no-op (no flag needed). Red: a genuine rejection OR an incomplete run (the
  // chain stalled / never reviewed) — both warrant attention, but they now carry
  // distinct messages above rather than both reading "REJECTED".
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
