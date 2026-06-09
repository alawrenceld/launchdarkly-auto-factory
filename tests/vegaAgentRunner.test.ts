import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VegaAgentRunner,
  VegaClient,
  type VegaDispatchRequest,
  type VegaStatusResult,
  type VegaTransport,
} from "@auto-factory/shared";

/** Transport that echoes the dispatched configKey and returns scripted tags. */
class EchoTransport implements VegaTransport {
  lastMaxTurns: number | undefined;
  async dispatch(req: VegaDispatchRequest) {
    this.lastMaxTurns = req.maxTurns;
    return { conversationId: req.configKey };
  }
  async getStatus(conversationId: string): Promise<VegaStatusResult> {
    return {
      conversationId,
      status: "completed",
      messages: [{ role: "assistant", content: `done: ${conversationId}`, isFinal: true }],
      tags: { review_approved: "approve" },
    };
  }
}

describe("VegaAgentRunner", () => {
  it("maps the Vega status result field-for-field onto AgentNodeResult", async () => {
    const runner = new VegaAgentRunner(new VegaClient(new EchoTransport()));
    const r = await runner.runNode({ configKey: "research", prompt: "hi" });
    assert.equal(r.status, "completed");
    assert.equal(r.messages[0]?.content, "done: research");
    assert.deepEqual(r.tags, { review_approved: "approve" });
  });

  it("forwards maxTurns through to the dispatch", async () => {
    const transport = new EchoTransport();
    const runner = new VegaAgentRunner(new VegaClient(transport));
    await runner.runNode({ configKey: "flag", prompt: "x", maxTurns: 7 });
    assert.equal(transport.lastMaxTurns, 7);
  });
});
