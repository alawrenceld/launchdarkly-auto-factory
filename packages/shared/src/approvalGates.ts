/**
 * Per-step approval gates: WHERE approvals happen. Gates pause the chain
 * BEFORE a configured agent runs, so a human can approve mid-chain — e.g.
 * "approve after research, before the flag implementer creates anything".
 *
 * The gated steps are read from the `auto-factory-approval-gates` LaunchDarkly
 * flag (a JSON flag), evaluated NATIVELY through the server SDK. WHETHER these
 * gates are active — and whether they're risk-conditional — is decided by the
 * approval-mode + risk-threshold flags; the three compile together in
 * approvalPolicy.ts.
 *
 * How a gate is satisfied differs by front end (see GateController in
 * graphWalker.ts): the GitHub Action reads PR labels; the Cursor extension
 * prompts interactively.
 */

import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";
import { loadDotEnv } from "./env.js";

export const APPROVAL_GATES_FLAG_KEY = "auto-factory-approval-gates";

/**
 * One gated step. The flag array accepts plain node-key strings and — for
 * per-step sensitivity — `{step, threshold}` objects, where `threshold`
 * overrides the blanket `auto-factory-risk-threshold` for that step in
 * risk-threshold mode. Strings and objects can be mixed in one array.
 */
export interface GateStep {
  step: string;
  threshold?: number;
}

/** Coerce an arbitrary flag value into a clean list of gate steps. */
export function parseGateSteps(value: unknown): GateStep[] {
  if (!Array.isArray(value)) return [];
  const steps: GateStep[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.length > 0) {
      steps.push({ step: v });
    } else if (v && typeof v === "object" && typeof (v as { step?: unknown }).step === "string") {
      const o = v as { step: string; threshold?: unknown };
      const t = typeof o.threshold === "number" && o.threshold >= 0 && o.threshold <= 1 ? o.threshold : undefined;
      steps.push({ step: o.step, ...(t !== undefined ? { threshold: t } : {}) });
    }
  }
  return steps;
}

/**
 * Resolve the gated steps. An `APPROVAL_GATES` env var (comma- or
 * JSON-array-encoded) overrides the flag — handy for local runs and tests
 * without touching LaunchDarkly. Otherwise reads the JSON flag (default none).
 */
export async function resolveApprovalGates(
  ldClient: LDClient,
  context: LDContext,
  flagKey: string = APPROVAL_GATES_FLAG_KEY,
): Promise<GateStep[]> {
  loadDotEnv();
  const env = process.env.APPROVAL_GATES?.trim();
  if (env) {
    try {
      return parseGateSteps(JSON.parse(env));
    } catch {
      return parseGateSteps(env.split(",").map((s) => s.trim()));
    }
  }
  const value = await ldClient.variation(flagKey, context, []);
  return parseGateSteps(value);
}
