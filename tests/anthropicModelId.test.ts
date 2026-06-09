import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { anthropicModelId } from "@auto-factory/shared";

describe("anthropicModelId", () => {
  it("passes a bare model id through unchanged", () => {
    assert.equal(anthropicModelId("claude-sonnet-4-6"), "claude-sonnet-4-6");
  });

  it("strips a single provider prefix (case-insensitive)", () => {
    assert.equal(anthropicModelId("Anthropic.claude-sonnet-4-6"), "claude-sonnet-4-6");
    assert.equal(anthropicModelId("anthropic.claude-haiku-4-5"), "claude-haiku-4-5");
  });

  it("strips a region segment + provider prefix, keeping multi-dot ids intact", () => {
    assert.equal(
      anthropicModelId("us.anthropic.claude-sonnet-4-6-v1:0"),
      "claude-sonnet-4-6-v1:0",
    );
  });

  it("does not mangle a bare multi-dot/versioned id", () => {
    assert.equal(anthropicModelId("claude-sonnet-4-6-v1:0"), "claude-sonnet-4-6-v1:0");
  });

  it("falls back to the default for empty/undefined", () => {
    assert.notEqual(anthropicModelId(undefined), "");
    assert.notEqual(anthropicModelId(""), "");
    assert.equal(anthropicModelId(undefined), anthropicModelId(""));
  });
});
