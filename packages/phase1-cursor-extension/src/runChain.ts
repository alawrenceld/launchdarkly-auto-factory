/**
 * Phase 1 orchestration for the editor. This is the Cursor analog of the
 * Action's `main()`: same shared core (provider resolution, graph resolution,
 * graph walk, approval), different seams.
 *
 *  - Context comes from the working tree, not a PR.
 *  - The Anthropic runner uses gitMode "workingTree": the agents' edits land in
 *    the working tree for the developer to review and commit; nothing is pushed.
 *  - Progress streams through a RunReporter instead of a PR comment.
 *
 * No VS Code imports here on purpose — the only dependency is the shared core.
 */

import {
  AnthropicAgentRunner,
  LdClient,
  LdResourceWriter,
  appConnection,
  decideApproval,
  getApprovalMode,
  getLdSdk,
  interpretWalk,
  pipelineContext,
  resolveAiProvider,
  walkGraph,
} from "@auto-factory/shared";
import type { CursorContext } from "./cursorContext.js";
import { buildContextVariables } from "./cursorContext.js";
import type { RunReporter, RunResult } from "./reporter.js";

export interface RunOptions {
  workspaceRoot: string;
  context: CursorContext;
  graphKey: string;
  appProjectKey: string;
  flagCreation: boolean;
  codeChanges: boolean;
  reporter: RunReporter;
}

/** A writer for real flag/metric creation in the app project, or undefined. */
function buildWriter(flagCreation: boolean): LdResourceWriter | undefined {
  if (!flagCreation) return undefined;
  if (!process.env.LD_API_KEY) throw new Error("Flag creation is on but no LaunchDarkly API key is set.");
  if (!process.env.LD_APP_PROJECT_KEY) throw new Error("Flag creation is on but no app project key is set.");
  return new LdResourceWriter(new LdClient(appConnection()));
}

export async function runPhase1(opts: RunOptions): Promise<RunResult> {
  const { reporter } = opts;

  const { ldClient, aiClient } = await getLdSdk();
  const ldContext = pipelineContext();

  // The extension executes the chain locally, so it always uses the Anthropic
  // runner. We still read the provider flag for parity and surface a note if a
  // hosted provider (Vega) is selected, since that path can't edit your tree.
  const provider = await resolveAiProvider(ldClient, ldContext);
  if (provider !== "anthropic") {
    reporter.log(`Provider flag selects '${provider}', but the editor extension runs locally on Anthropic. Using Anthropic.`);
  }

  const variables = buildContextVariables(opts.context, opts.appProjectKey);
  const graphDef = await aiClient.agentGraph(opts.graphKey, ldContext, variables);
  if (!graphDef.enabled) {
    throw new Error(`Agent graph '${opts.graphKey}' is disabled or unavailable in LaunchDarkly.`);
  }
  const graphTracker = graphDef.createTracker();

  const writer = buildWriter(opts.flagCreation);
  reporter.log(`Flag/metric creation: ${writer ? `enabled → '${writer.projectKey}'` : "disabled (read-only)"}.`);
  reporter.log(`Code changes: ${opts.codeChanges ? "enabled (edits land in your working tree)" : "disabled"}.`);

  const runner = new AnthropicAgentRunner({
    sandboxRoot: opts.workspaceRoot,
    codeChangesEnabled: opts.codeChanges,
    gitMode: "workingTree",
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
    ...(writer ? { writer } : {}),
    ...(opts.context.PR_BRANCH ? { prBranch: String(opts.context.PR_BRANCH) } : {}),
    ...(process.env.PR_BASE_REF ? { prBaseRef: process.env.PR_BASE_REF } : {}),
  });

  const walk = await walkGraph(graphDef, runner, opts.context, graphTracker, (event) => {
    if (event.type === "node-start") reporter.nodeStart(event.configKey);
    else if (event.type === "node-complete") reporter.nodeComplete(event.run);
    else if (event.type === "stalled") {
      const u = event.stall.unmet
        .map((e) => `→ ${e.target} needs ${Object.entries(e.requireMissing).map(([k, v]) => `${k}=${v}`).join(", ")}`)
        .join("; ");
      reporter.log(`⚠ chain stalled at ${event.stall.node}: unmet handoff ${u}`);
    }
  });

  const { reviewApproved, risk, skipFlagging } = interpretWalk(walk.tags);
  const mode = getApprovalMode();
  const decision = decideApproval(mode, reviewApproved, risk, skipFlagging);

  const result: RunResult = {
    runs: walk.runs,
    skipped: walk.skipped,
    tags: walk.tags,
    decision,
    mode,
    provider,
  };
  reporter.done(result);
  return result;
}
