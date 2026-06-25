/**
 * Native LaunchDarkly SDK bootstrap for the Phase 1 runtime.
 *
 * This is the LaunchDarkly-native foundation the prototype runs on:
 *   - the Node *server SDK* (`@launchdarkly/node-server-sdk`) evaluates flags
 *     (e.g. the AI-provider selector), and
 *   - the Node *AI SDK* (`@launchdarkly/server-sdk-ai`) resolves agent configs
 *     and agent graphs (interpolated instructions + model + generation tracking).
 *
 * Both share one server-SDK client, created from the `LD_SDK_KEY` (the `sdk-`
 * key — distinct from the `api-` PAT used for REST writes like flag creation).
 * The client is environment-scoped to the FACTORY/control-plane project that
 * holds the AI configs, graph, and operational flags.
 */

import { type LDClient, type LDContext, type LDOptions, init } from "@launchdarkly/node-server-sdk";
import { type LDAIClient, initAi } from "@launchdarkly/server-sdk-ai";
import { loadDotEnv } from "./env.js";

/**
 * Build the LaunchDarkly LLM Observability plugin, if available. Lazy + defensive
 * on purpose: `@launchdarkly/observability-node` is heavy (OTel + instrumentation)
 * and is marked external in the action bundle, so loading it can't be a hard
 * dependency of every provider path. If the package is absent or init fails, we
 * continue WITHOUT observability rather than break the run. The plugin sets up the
 * global OTel tracer + an exporter to LD's OTLP endpoint; the per-node gen_ai spans
 * are emitted in the runners (see observability.ts).
 *
 * Set DISABLE_LD_OBSERVABILITY=true to opt out.
 */
async function observabilityPlugins(): Promise<NonNullable<LDOptions["plugins"]>> {
  if (process.env.DISABLE_LD_OBSERVABILITY === "true") return [];
  try {
    const { Observability } = await import("@launchdarkly/observability-node");
    const plugin = new Observability({
      serviceName: process.env.LD_OBSERVABILITY_SERVICE ?? "auto-factory-phase1",
      serviceVersion: process.env.GITHUB_SHA ?? "dev",
      environment: "production",
    });
    // The plugin's type is from the external package; the SDK accepts it structurally.
    return [plugin as unknown as NonNullable<LDOptions["plugins"]>[number]];
  } catch (e) {
    console.warn(`[observability] LLM observability unavailable (${e instanceof Error ? e.message : e}); continuing without it.`);
    return [];
  }
}

export interface LdSdk {
  /** Server SDK client — flag evaluation. */
  ldClient: LDClient;
  /** AI SDK client — agent configs + agent graphs + tracking. */
  aiClient: LDAIClient;
}

let cached: LdSdk | null = null;

/** Initialize (once) and return the shared LaunchDarkly server + AI SDK clients. */
export async function getLdSdk(): Promise<LdSdk> {
  if (cached) return cached;
  loadDotEnv();
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) {
    throw new Error("LD_SDK_KEY not set — the server SDK key for flag evaluation and AI config/graph resolution");
  }
  const ldClient = init(sdkKey, { plugins: await observabilityPlugins() });
  await ldClient.waitForInitialization({ timeout: 15 });
  const aiClient = initAi(ldClient);
  cached = { ldClient, aiClient };
  return cached;
}

/** Flush and close the SDK so the process can exit (the client holds the event loop open). */
export async function closeLdSdk(): Promise<void> {
  if (!cached) return;
  // Flush LLM-observability spans before the (short-lived CI) process exits, or
  // they may never reach LaunchDarkly. Best-effort and only if the plugin loaded.
  try {
    const { LDObserve } = await import("@launchdarkly/observability-node");
    await LDObserve.flush();
  } catch {
    /* observability not enabled / not installed — nothing to flush */
  }
  try {
    await cached.ldClient.flush();
  } catch {
    /* best-effort */
  }
  await cached.ldClient.close();
  cached = null;
}

/**
 * The LaunchDarkly context for this pipeline run. Used both for flag evaluation
 * and as the targeting context for AI config/graph resolution, so a customer can
 * target rules at specific repos/pipelines later.
 */
export function pipelineContext(extra: Record<string, unknown> = {}): LDContext {
  return {
    kind: "service",
    key: process.env.LD_PIPELINE_CONTEXT_KEY ?? "auto-factory-phase1",
    name: "AutoFactory Phase 1",
    ...extra,
  } as LDContext;
}
