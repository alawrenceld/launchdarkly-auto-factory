import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  AgentRunner,
} from "@auto-factory/shared";
import { walkGraph } from "@auto-factory/phase1-resource-factory";

/**
 * Fake runner: returns a scripted `{status, tags}` per config key (no network,
 * no Anthropic/Vega plumbing). The final assistant message is synthesized so the
 * walker has something to carry forward as PREVIOUS_STEP_OUTPUT.
 */
class FakeRunner implements AgentRunner {
  constructor(private readonly scriptByKey: Record<string, Partial<AgentNodeResult>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    const scripted = this.scriptByKey[req.configKey] ?? {};
    return {
      status: scripted.status ?? "completed",
      messages: scripted.messages ?? [
        { role: "assistant", content: `done: ${req.configKey}`, isFinal: true },
      ],
      tags: scripted.tags ?? {},
    };
  }
}

/** Minimal LDAIConfigTracker stub — the fake runner never reads it. */
const fakeConfigTracker = () => ({}) as unknown as LDAIConfigTracker;

/** Build an LDAIAgentConfig for a node key. */
function agentConfig(key: string): LDAIAgentConfig {
  return {
    key,
    enabled: true,
    instructions: `instructions for ${key}`,
    model: { name: "Anthropic.claude-sonnet-4-6" },
    createTracker: fakeConfigTracker,
  } as LDAIAgentConfig;
}

/**
 * Build a real `AgentGraphDefinition` for the linear research → flag → test →
 * review chain the walker traverses, with the same handoff conditions the
 * canonical graph uses.
 */
function buildGraph(): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = {
    root: "research",
    edges: {
      research: [{ key: "flag", handoff: { skip_if_tags: { skip_flagging: "true" } } }],
      flag: [{ key: "test", handoff: { require_tags: { flag_created: "true" } } }],
      test: [{ key: "review" }],
    },
  };
  const configs: Record<string, LDAIAgentConfig> = {
    research: agentConfig("research"),
    flag: agentConfig("flag"),
    test: agentConfig("test"),
    review: agentConfig("review"),
  };
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(
    flagValue,
    nodes,
    true,
    () => ({}) as unknown as LDGraphTracker,
  );
}

const run = (script: Record<string, Partial<AgentNodeResult>>) =>
  walkGraph(buildGraph(), new FakeRunner(script), { PR_NUMBER: "1" });

describe("walkGraph", () => {
  it("runs the full chain when conditions pass", async () => {
    const r = await run({
      flag: { tags: { flag_created: "true" } },
      review: { tags: { review_approved: "approve" } },
    });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
    assert.equal(r.skipped.length, 0);
  });

  it("short-circuits when research sets skip_flagging (no flag needed)", async () => {
    const r = await run({ research: { tags: { skip_flagging: "true" } } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.skipped.sort(), ["flag", "review", "test"]);
  });

  it("stops at flag when require_tags(flag_created) is unmet", async () => {
    const r = await run({ flag: { tags: {} } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag"],
    );
    assert.ok(r.skipped.includes("test") && r.skipped.includes("review"));
  });
});
