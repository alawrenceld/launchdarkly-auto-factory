/**
 * Anthropic implementation of the judge completion: a single structured
 * completion for the SDK Judge class. Structured output is obtained with a
 * FORCED tool call whose input schema is the judge's evaluation schema
 * ({score, reasoning}) — no free-text JSON parsing needed.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { JudgeCompletion } from "../judges.js";
import { anthropicModelId } from "./anthropicAgentRunner.js";

const MAX_TOKENS = 1024;

export function createAnthropicJudgeCompletion(apiKey?: string): JudgeCompletion {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return async (req) => {
    const resp = await client.messages.create({
      model: anthropicModelId(req.model),
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: "user", content: req.input }],
      tools: [
        {
          name: "record_evaluation",
          description: "Record the evaluation result for the response under review.",
          input_schema: req.schema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "record_evaluation" },
    });
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    return {
      ...(toolUse ? { parsed: toolUse.input as Record<string, unknown> } : {}),
      content: JSON.stringify(toolUse?.input ?? null),
      success: toolUse !== undefined,
      tokens: {
        input: resp.usage.input_tokens,
        output: resp.usage.output_tokens,
        total: resp.usage.input_tokens + resp.usage.output_tokens,
      },
    };
  };
}
