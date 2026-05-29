import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VegaClient, type VegaDispatchRequest, type VegaStatusResult, type VegaTransport } from "@auto-factory/shared";
import { type AgentGraph, walkGraph } from "@auto-factory/phase1-resource-factory";

/** Fake transport returning scripted tags per config key (no network). */
class FakeTransport implements VegaTransport {
  constructor(private readonly tagsByKey: Record<string, Record<string, string>>) {}
  async dispatch(req: VegaDispatchRequest) {
    return { conversationId: req.configKey };
  }
  async getStatus(conversationId: string): Promise<VegaStatusResult> {
    return {
      conversationId,
      status: "completed",
      messages: [{ role: "assistant", content: `done: ${conversationId}`, isFinal: true }],
      tags: this.tagsByKey[conversationId] ?? {},
    };
  }
}

const graph: AgentGraph = {
  key: "g",
  rootConfigKey: "research",
  edges: [
    { key: "e1", sourceConfig: "research", targetConfig: "flag", handoff: { skip_if_tags: { skip_flagging: "true" } } },
    { key: "e2", sourceConfig: "flag", targetConfig: "test", handoff: { require_tags: { flag_created: "true" } } },
    { key: "e3", sourceConfig: "test", targetConfig: "review" },
  ],
};

const run = (tags: Record<string, Record<string, string>>) =>
  walkGraph(graph, new VegaClient(new FakeTransport(tags)), { PR_NUMBER: "1" });

describe("walkGraph", () => {
  it("runs the full chain when conditions pass", async () => {
    const r = await run({ flag: { flag_created: "true" }, review: { review_decision: "approve" } });
    assert.deepEqual(r.runs.map((x) => x.configKey), ["research", "flag", "test", "review"]);
    assert.equal(r.skipped.length, 0);
  });

  it("short-circuits when research sets skip_flagging (no flag needed)", async () => {
    const r = await run({ research: { skip_flagging: "true" } });
    assert.deepEqual(r.runs.map((x) => x.configKey), ["research"]);
    assert.deepEqual(r.skipped.sort(), ["flag", "review", "test"]);
  });

  it("stops at flag when require_tags(flag_created) is unmet", async () => {
    const r = await run({ flag: {} });
    assert.deepEqual(r.runs.map((x) => x.configKey), ["research", "flag"]);
    assert.ok(r.skipped.includes("test") && r.skipped.includes("review"));
  });
});
