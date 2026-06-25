/**
 * LaunchDarkly LLM Observability helpers.
 *
 * LD's LLM Observability is OpenTelemetry-based (GenAI semantic conventions). The
 * `Observability` plugin (registered on the server SDK in ldSdk.ts) sets up the
 * global OTel tracer + an exporter to LaunchDarkly's OTLP endpoint. We then emit a
 * span per agent run with `gen_ai.*` attributes so each LLM call shows up in LD's
 * LLM Observability views, correlated to the AgentControl config that produced it.
 *
 * The Cursor provider needs MANUAL spans: inference happens inside Cursor's hosted
 * service, so there's no local LLM SDK for the plugin to auto-instrument — we set
 * the attributes ourselves from what `RunResult` gives us (model, token usage,
 * duration). All helpers here are defensive: telemetry must never break a run.
 */

import type { LDAIConfigTracker } from "@launchdarkly/server-sdk-ai";
import { type Attributes, type Span, SpanKind, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

const TRACER_NAME = "launchdarkly-auto-factory";
/** Cap prompt/completion content recorded on a span so spans stay bounded. */
const MAX_CONTENT = 8000;

export { SpanKind, SpanStatusCode };

/**
 * The AutoFactory OTel tracer. When the Observability plugin is registered this
 * is backed by LD's exporter; otherwise it's the OTel no-op tracer, so callers
 * can always create spans without checking whether observability is enabled.
 */
export function aiTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

function truncate(s: string): string {
  return s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…[truncated]` : s;
}

export interface GenAiSpanData {
  /** gen_ai.system / gen_ai.provider — the execution backend, e.g. "cursor". */
  provider: string;
  /** gen_ai.request.model — the model actually run (e.g. the resolved Cursor model id). */
  requestModel: string;
  /** The node's AI-config tracker, for correlating the span to the AgentControl config. */
  tracker?: LDAIConfigTracker;
  /** The rendered prompt sent to the model (recorded as gen_ai.input, truncated). */
  prompt?: string;
  /** The model's final output (recorded as gen_ai.output, truncated). */
  output?: string;
  /** Token usage from the provider, if reported. */
  usage?: { input: number; output: number; total: number };
}

/**
 * Set GenAI + LaunchDarkly-AI-config attributes on a span. Both the OTel GenAI
 * convention keys (`gen_ai.usage.input_tokens`, …) and the flatter keys the LD
 * docs list (`gen_ai.provider`, `gen_ai.model`, prompt/completion tokens) are set,
 * so the LLM Observability view picks them up regardless of which it keys on.
 * Never throws.
 */
export function setGenAiAttributes(span: Span, d: GenAiSpanData): void {
  try {
    const attrs: Attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.system": d.provider,
      "gen_ai.provider": d.provider,
      "gen_ai.request.model": d.requestModel,
      "gen_ai.model": d.requestModel,
    };
    if (d.usage) {
      attrs["gen_ai.usage.input_tokens"] = d.usage.input;
      attrs["gen_ai.usage.output_tokens"] = d.usage.output;
      attrs["gen_ai.usage.total_tokens"] = d.usage.total;
      // Older convention aliases (some views still read these).
      attrs["gen_ai.usage.prompt_tokens"] = d.usage.input;
      attrs["gen_ai.usage.completion_tokens"] = d.usage.output;
    }
    if (d.prompt) attrs["gen_ai.input"] = truncate(d.prompt);
    if (d.output) attrs["gen_ai.output"] = truncate(d.output);

    // Correlate the span to the AgentControl config it ran, so LLM Observability
    // lines up with the same config's AI Config metrics.
    const td = d.tracker?.getTrackData?.();
    if (td) {
      attrs["launchdarkly.ai.config.key"] = td.configKey;
      attrs["launchdarkly.ai.config.variation"] = td.variationKey;
      attrs["launchdarkly.ai.config.version"] = td.version;
      attrs["launchdarkly.ai.config.model"] = td.modelName;
      attrs["launchdarkly.ai.provider"] = td.providerName;
      attrs["launchdarkly.ai.run.id"] = td.runId;
      if (td.graphKey) attrs["launchdarkly.ai.graph.key"] = td.graphKey;
    }
    span.setAttributes(attrs);
  } catch {
    /* telemetry must never break the run */
  }
}
