#!/usr/bin/env node
/**
 * check-configs — validates the agent configs against the tool + graph contract,
 * so the routing-tag failure modes in issue #9 can't silently regress.
 *
 * Two checks over config/agentcontrol/:
 *   1. Tool-signature lint. The `tag_conversation` tool accepts a single `tags`
 *      object ({"tags": {"k": "v"}}). Instructions that call it as
 *      `tag_conversation(key=…, value=…)` make the model emit NO tags, which
 *      stalls the chain. Flag that form.
 *   2. Graph tag reachability. Every tag a graph edge gates on (require_tags /
 *      skip_if_tags) must be producible by SOME agent — either emitted in a
 *      config's instructions or set automatically by a write tool. A required
 *      tag with no producer means that edge can never be taken (chain stalls).
 *
 * Run: node scripts/check-configs.mjs   (wired as `npm run check:configs`)
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const AI_CONFIG_DIR = "config/agentcontrol/ai-configs";
const GRAPH_DIR = "config/agentcontrol/graphs";

/**
 * Tags set automatically by the sandbox write tools (see sandboxTools.ts:
 * create_flag sets flag_created/flag_key; create_metric sets
 * metrics_created/metric_keys), so they're "produced" even if an agent's
 * instructions never mention them.
 */
const TOOL_AUTO_TAGS = new Set(["flag_created", "flag_key", "metrics_created", "metric_keys"]);

function listJson(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Instructions of a config's first (default) variation. */
function instructionsOf(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  return cfg.variations?.[0]?.instructions ?? "";
}

const violations = [];

// --- Check 1: invalid tag_conversation signature -------------------------
const configFiles = listJson(AI_CONFIG_DIR);
const allInstructions = []; // { name, text }
for (const file of configFiles) {
  const name = basename(file, ".json");
  const text = instructionsOf(file);
  allInstructions.push({ name, text });
  // The only valid call passes a `tags` object; `tag_conversation(key…` is the
  // broken positional/keyword form that emits nothing.
  const bad = text.match(/tag_conversation\(\s*key\b[^)]*\)/g);
  if (bad) {
    for (const call of bad) {
      violations.push(
        `${name}: invalid tag_conversation signature \`${call.slice(0, 70)}\` — the tool takes a single tags object, e.g. tag_conversation({"tags": {"needs_tests": "true"}})`,
      );
    }
  }
}

// --- Check 2: graph tag reachability -------------------------------------
// A tag is "producible" if a tool auto-sets it or some instruction mentions it.
const producible = new Set(TOOL_AUTO_TAGS);
for (const { text } of allInstructions) {
  for (const tag of text.match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
    // cheap membership signal: the literal tag key appears in instructions
    producible.add(tag);
  }
}

for (const file of listJson(GRAPH_DIR)) {
  const graph = JSON.parse(readFileSync(file, "utf8"));
  const gname = basename(file, ".json");
  for (const edge of graph.edges ?? []) {
    const h = edge.handoff ?? {};
    const required = { ...(h.require_tags ?? {}), ...(h.skip_if_tags ?? {}) };
    for (const tag of Object.keys(required)) {
      if (!producible.has(tag)) {
        violations.push(
          `${gname}: edge ${edge.sourceConfig} → ${edge.targetConfig} gates on tag '${tag}', but no agent's instructions emit it and no tool sets it — that edge can never be taken.`,
        );
      }
    }
  }
}

// --- Report --------------------------------------------------------------
if (configFiles.length === 0) {
  console.error(`✗ no agent configs found under ${AI_CONFIG_DIR}`);
  process.exit(1);
}
if (violations.length) {
  console.error("✗ check-configs found routing-contract violations:\n");
  for (const v of violations) console.error(`    ${v}`);
  console.error(`\ncheck-configs FAILED with ${violations.length} issue(s).`);
  process.exit(1);
}
console.log(`check-configs passed ✓ (${configFiles.length} configs, graph tags reachable)`);
