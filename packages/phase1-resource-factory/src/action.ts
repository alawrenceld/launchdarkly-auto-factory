#!/usr/bin/env node
/**
 * Phase 1 GitHub Action entrypoint. Triggered on PR open/synchronize (no label
 * gate). Assembles PR context, walks the agent graph on Vega, then applies the
 * approval decision.
 *
 * ⚠️ The Vega transport is a stub until real API docs land (ISSUES I1). Wiring it
 * is a localized change in `createVegaClient()` — the rest of this flow is ready.
 */

import { readFileSync } from "node:fs";
import { StubVegaTransport, VegaClient, type VegaTransport } from "@auto-factory/shared";
import { decideApproval, getApprovalMode, interpretWalk } from "./approval.js";
import { type AgentGraph, walkGraph } from "./graphWalker.js";
import { assemblePrContext } from "./prContext.js";

/** Swap this for the real transport when the Vega API is documented (ISSUES I1). */
function createVegaClient(): VegaClient {
  const transport: VegaTransport = new StubVegaTransport();
  return new VegaClient(transport);
}

function loadGraph(): AgentGraph {
  const path = process.env.GRAPH_FILE;
  if (!path) throw new Error("GRAPH_FILE not set (path to the agent graph JSON)");
  return JSON.parse(readFileSync(path, "utf8")) as AgentGraph;
}

/** GitHub Actions exposes `with:` inputs as INPUT_<NAME>. Map them to the plain
 *  env vars the rest of the code reads. */
function mapActionInputs(): void {
  const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`];
  const set = (envName: string, inputName: string) => {
    const v = input(inputName);
    if (v && !process.env[envName]) process.env[envName] = v;
  };
  set("LD_API_KEY", "ld_api_key");
  set("LD_BASE_URL", "ld_base_url");
  set("LD_PROJECT_KEY", "ld_project_key");
  set("GRAPH_FILE", "graph_file");
  set("APPROVAL_MODE", "approval_mode");
  set("GITHUB_TOKEN", "github_token");
}

async function main(): Promise<void> {
  mapActionInputs();
  const graph = loadGraph();
  const context = assemblePrContext();
  console.log(`Phase 1: PR #${context.PR_NUMBER ?? "?"} → graph '${graph.key}'`);

  const vega = createVegaClient();
  const walk = await walkGraph(graph, vega, context);

  console.log(`Ran ${walk.runs.length} node(s): ${walk.runs.map((r) => r.configKey).join(" → ")}`);
  if (walk.skipped.length) console.log(`Skipped: ${walk.skipped.join(", ")}`);

  const { reviewApproved, risk } = interpretWalk(walk.tags);
  const mode = getApprovalMode();
  const decision = decideApproval(mode, reviewApproved, risk);

  console.log(`Approval [${mode}] → ${decision.reason}`);
  if (decision.requiresHuman) {
    console.log("⏸ Human approval required — not auto-applied.");
  } else if (decision.apply) {
    console.log("✓ Changes approved and applied by the agents.");
  } else {
    console.log("✗ Not applied.");
  }

  // Non-zero exit signals the PR check should fail (rejected).
  if (!decision.apply && !decision.requiresHuman) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
