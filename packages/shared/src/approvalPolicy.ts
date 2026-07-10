/**
 * The approval policy: three LaunchDarkly flags that COMPILE INTO pre-execution
 * gates. This is the whole approval model — there is no post-hoc approval step
 * (by the end of a walk everything is already created and pushed; see
 * approval.ts for the verdict reporting that remains).
 *
 *   1. `auto-factory-approval-mode`   — whether approvals happen at all:
 *        yolo (default)  → no gates, chain runs unattended
 *        risk-threshold  → gate the configured steps only when the research
 *                          agent's `risk_score` ≥ the threshold
 *        always          → gate the configured steps on every run
 *   2. `auto-factory-risk-threshold`  — number 0..1; the sensitivity dial for
 *        risk-threshold mode. Tune it up/down based on what you see run.
 *   3. `auto-factory-approval-gates`  — WHERE approvals happen: an array of
 *        agent node keys. Entries may also be `{step, threshold}` objects to
 *        override the blanket threshold per step (forward-compatible shape).
 *
 * Compilation:  effective gate on step S =
 *   yolo → never; always → always; risk-threshold → risk_score ≥ threshold(S).
 * Risk comes from the tags accumulated BEFORE the gated node runs (the research
 * planner is the root, so its `risk_score` exists by the time any later node's
 * gate is checked). FAIL-CLOSED: in risk-threshold mode an absent/unparsable
 * risk score gates the step — an unknown risk must not slip through unattended.
 *
 * Env overrides for local runs/tests (same pattern as the other flags):
 * APPROVAL_MODE (legacy values map: middle → risk-threshold, manual → always)
 * and RISK_THRESHOLD.
 */

import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";
import { type GateStep, resolveApprovalGates } from "./approvalGates.js";
import { loadDotEnv } from "./env.js";
import type { GateController } from "./graphWalker.js";
import type { ApprovalMode, RiskLevel } from "./types.js";

export const APPROVAL_MODE_FLAG_KEY = "auto-factory-approval-mode";
export const RISK_THRESHOLD_FLAG_KEY = "auto-factory-risk-threshold";

const DEFAULT_MODE: ApprovalMode = "yolo";
const DEFAULT_THRESHOLD = 0.6;
/** Non-yolo modes with no configured steps gate the implementer at minimum. */
export const DEFAULT_GATED_STEPS: readonly string[] = ["autofactory-flag-implementer"];

/** Map raw/legacy mode strings onto the current modes. */
export function normalizeApprovalMode(raw: unknown): ApprovalMode {
  const m = String(raw ?? "").toLowerCase().trim();
  if (m === "risk-threshold" || m === "middle") return "risk-threshold";
  if (m === "always" || m === "manual") return "always";
  return DEFAULT_MODE;
}

/**
 * Numeric risk from the accumulated tags: the planner's `risk_score` (0..1),
 * else a fixed mapping of the categorical `risk_level`, else undefined.
 */
export function riskScoreOf(tags: Record<string, string>): number | undefined {
  const raw = Number.parseFloat(tags.risk_score ?? "");
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  const level = (tags.risk_level ?? "").toLowerCase() as RiskLevel | "";
  if (level === "low") return 0.25;
  if (level === "medium") return 0.5;
  if (level === "high") return 0.75;
  return undefined;
}

export interface ApprovalPolicy {
  mode: ApprovalMode;
  /** Blanket risk threshold (0..1) for risk-threshold mode. */
  threshold: number;
  /** Steps that MAY be gated (with optional per-step threshold overrides). */
  steps: GateStep[];
  /** Where the mode came from: the LD flag, or the APPROVAL_MODE env override. */
  modeSource: "flag" | "env";
}

/** Resolve the three flags (with env overrides) into one policy. */
export async function resolveApprovalPolicy(ldClient: LDClient, context: LDContext): Promise<ApprovalPolicy> {
  loadDotEnv();

  const modeSource: ApprovalPolicy["modeSource"] = process.env.APPROVAL_MODE ? "env" : "flag";
  const mode = process.env.APPROVAL_MODE
    ? normalizeApprovalMode(process.env.APPROVAL_MODE)
    : normalizeApprovalMode(await ldClient.variation(APPROVAL_MODE_FLAG_KEY, context, DEFAULT_MODE));
  if (modeSource === "env") {
    // The env override is a local-run escape hatch. In CI it silently defeats
    // the flag control plane (a stale workflow hardcoding APPROVAL_MODE: yolo
    // bypassed a tester's mode=always gates), so it must be LOUD.
    const flagMode = normalizeApprovalMode(await ldClient.variation(APPROVAL_MODE_FLAG_KEY, context, DEFAULT_MODE));
    const conflict = flagMode !== mode ? ` — the ${APPROVAL_MODE_FLAG_KEY} flag says '${flagMode}' and is being IGNORED` : "";
    const msg = `approval mode '${mode}' comes from the APPROVAL_MODE env var, not LaunchDarkly${conflict}. Remove APPROVAL_MODE from the workflow to let the flags control approvals.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::AutoFactory: ${msg}` : `[approval] ${msg}`);
  }

  const rawThreshold = process.env.RISK_THRESHOLD
    ? Number.parseFloat(process.env.RISK_THRESHOLD)
    : Number(await ldClient.variation(RISK_THRESHOLD_FLAG_KEY, context, DEFAULT_THRESHOLD));
  const threshold = Number.isFinite(rawThreshold) ? Math.min(1, Math.max(0, rawThreshold)) : DEFAULT_THRESHOLD;

  let steps = await resolveApprovalGates(ldClient, context);
  if (steps.length === 0 && mode !== "yolo") {
    // "Approve nothing anywhere" is never what a non-yolo mode means. Gate the
    // first side-effecting step so flipping the mode flag always does something.
    console.log(
      `[approval] mode '${mode}' with no gated steps configured — defaulting to [${DEFAULT_GATED_STEPS.join(", ")}]`,
    );
    steps = DEFAULT_GATED_STEPS.map((step) => ({ step }));
  }

  return { mode, threshold, steps, modeSource };
}

/**
 * Compile the policy into the walker's GateController. Returns undefined for
 * yolo (no gates at all). `approve` answers "has a human approved this step?"
 * (PR label in the Action; interactive modal in the extension).
 */
export function createPolicyGate(
  policy: ApprovalPolicy,
  approve: (nodeKey: string) => boolean | Promise<boolean>,
): GateController | undefined {
  if (policy.mode === "yolo" || policy.steps.length === 0) return undefined;
  const byStep = new Map(policy.steps.map((s) => [s.step, s]));
  return {
    steps: policy.steps.map((s) => s.step),
    async resolve(nodeKey, tags) {
      if (policy.mode === "risk-threshold") {
        const risk = riskScoreOf(tags);
        const effective = byStep.get(nodeKey)?.threshold ?? policy.threshold;
        if (risk !== undefined && risk < effective) {
          console.log(
            `[approval] '${nodeKey}' below risk threshold (risk ${risk.toFixed(2)} < ${effective.toFixed(2)}) — no approval needed`,
          );
          return true; // below threshold: proceed without human approval
        }
        console.log(
          `[approval] '${nodeKey}' requires approval: risk ${risk === undefined ? "UNKNOWN (fail-closed)" : risk.toFixed(2)} ≥ threshold ${effective.toFixed(2)}`,
        );
      }
      return approve(nodeKey);
    },
  };
}
