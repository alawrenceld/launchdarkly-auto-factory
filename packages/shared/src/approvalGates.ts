/**
 * Per-step approval gates. Independent of the post-walk APPROVAL_MODE (which
 * governs whether the FINISHED chain auto-applies): gates pause the chain
 * BEFORE a configured agent runs, so a human can approve mid-chain — e.g.
 * "approve after research, before the flag implementer creates anything".
 *
 * The gated steps are an array of agent node keys, read from the
 * `auto-factory-approval-gates` LaunchDarkly flag (a JSON flag), evaluated
 * NATIVELY through the server SDK — same pattern as the provider flag. Default
 * is no gates, so absent/unset flag preserves today's behavior exactly.
 *
 * How a gate is satisfied differs by front end (see GateController in
 * graphWalker.ts): the GitHub Action reads PR labels; the Cursor extension
 * prompts interactively.
 */

import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";
import { loadDotEnv } from "./env.js";

export const APPROVAL_GATES_FLAG_KEY = "auto-factory-approval-gates";

/** Coerce an arbitrary flag value into a clean list of node-key strings. */
function toSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Resolve the gated agent node keys. An `APPROVAL_GATES` env var (comma- or
 * JSON-array-encoded) overrides the flag — handy for local runs and tests
 * without touching LaunchDarkly. Otherwise reads the JSON flag (default none).
 */
export async function resolveApprovalGates(
  ldClient: LDClient,
  context: LDContext,
  flagKey: string = APPROVAL_GATES_FLAG_KEY,
): Promise<string[]> {
  loadDotEnv();
  const env = process.env.APPROVAL_GATES?.trim();
  if (env) {
    try {
      return toSteps(JSON.parse(env));
    } catch {
      return toSteps(env.split(",").map((s) => s.trim()));
    }
  }
  const value = await ldClient.variation(flagKey, context, []);
  return toSteps(value);
}
