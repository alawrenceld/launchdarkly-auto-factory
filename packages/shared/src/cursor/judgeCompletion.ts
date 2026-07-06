/**
 * Cursor implementation of the judge completion: one hermetic single-shot
 * Cursor agent run (`Agent.prompt`) per evaluation. Cursor has no structured-
 * output parameter, so the prompt demands JSON-only and the response is parsed
 * leniently (code fences stripped, outermost object extracted).
 *
 * Same lazy-load + hermeticity rules as the Cursor agent runner: @cursor/sdk is
 * imported on demand (external in the action bundle), and `settingSources: []`
 * keeps the analyzed repo's `.cursor/` config out of the judge.
 */

import type { ModelListItem } from "@cursor/sdk";
import type { JudgeCompletion } from "../judges.js";
import { mapToCursorModel } from "./cursorModel.js";

const DEFAULT_FALLBACK_MODEL = "auto";

type CursorSdk = typeof import("@cursor/sdk");
let sdkPromise: Promise<CursorSdk> | undefined;
function loadSdk(): Promise<CursorSdk> {
  if (!sdkPromise) sdkPromise = import("@cursor/sdk");
  return sdkPromise;
}

/** Extract the outermost JSON object from a possibly fenced / chatty response. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface CursorJudgeCompletionOptions {
  /** Cursor API key; falls back to CURSOR_API_KEY. */
  apiKey?: string;
  /** Fallback Cursor model id when the judge's LD model has no catalog match. */
  model?: string;
  /** Working directory for the local agent (no repo access needed; cwd default). */
  cwd?: string;
}

export function createCursorJudgeCompletion(opts: CursorJudgeCompletionOptions = {}): JudgeCompletion {
  const apiKey = opts.apiKey ?? process.env.CURSOR_API_KEY;
  const fallbackModel = opts.model ?? process.env.CURSOR_MODEL ?? DEFAULT_FALLBACK_MODEL;
  let catalog: ModelListItem[] | undefined;

  return async (req) => {
    const { Agent, Cursor } = await loadSdk();
    if (!catalog) {
      try {
        catalog = (await Cursor.models.list(apiKey ? { apiKey } : undefined)) as ModelListItem[];
      } catch {
        catalog = [];
      }
    }
    const match = mapToCursorModel(req.model, catalog, fallbackModel);
    const message =
      `${req.system}\n\n---\n\n${req.input}\n\n---\n` +
      `Respond with ONLY a single JSON object matching this schema (no prose, no code fences):\n` +
      JSON.stringify(req.schema);
    const result = await Agent.prompt(message, {
      ...(apiKey ? { apiKey } : {}),
      model: { id: match.id },
      // Hermetic + toolless-by-intent: judges only read the prompt.
      local: { cwd: opts.cwd ?? process.cwd(), settingSources: [] },
      mode: "agent",
    });
    const text = result.result ?? "";
    const parsed = extractJsonObject(text);
    return {
      ...(parsed ? { parsed } : {}),
      content: text,
      success: result.status === "finished" && parsed !== undefined,
      ...(result.usage
        ? { tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens, total: result.usage.totalTokens } }
        : {}),
    };
  };
}
