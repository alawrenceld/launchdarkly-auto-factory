/**
 * Approval logic. The agent chain produces a review verdict and a risk level
 * (as tags); the approval mode decides whether to auto-apply, gate on risk, or
 * require a human.
 *
 * The DECISION logic is firm. How the verdict/risk are read from agent tags is
 * best-effort (the exact tag keys agents emit are not yet pinned — see ISSUES I9),
 * so `interpretWalk` checks a few common keys and is easy to adjust.
 */

import type { ApprovalMode, RiskLevel } from "@auto-factory/shared";

export interface ApprovalDecision {
  apply: boolean;
  requiresHuman: boolean;
  reason: string;
}

/**
 * Resolve the active approval mode. Defaults to "yolo".
 * TODO(I6): read from a per-repo LaunchDarkly flag; this env fallback is the
 * hardcoded-config path until that flag's evaluation context is pinned.
 */
export function getApprovalMode(): ApprovalMode {
  const m = (process.env.APPROVAL_MODE || "yolo").toLowerCase();
  return m === "manual" || m === "middle" ? m : "yolo";
}

export function decideApproval(
  mode: ApprovalMode,
  reviewApproved: boolean,
  risk?: RiskLevel,
): ApprovalDecision {
  if (!reviewApproved) {
    return { apply: false, requiresHuman: false, reason: "code review REJECTED" };
  }
  switch (mode) {
    case "yolo":
      return { apply: true, requiresHuman: false, reason: "yolo: auto-apply on approval" };
    case "manual":
      return { apply: false, requiresHuman: true, reason: "manual: awaiting human approval" };
    case "middle":
      if (risk === "high") {
        return { apply: false, requiresHuman: true, reason: "middle: high risk → human approval" };
      }
      return { apply: true, requiresHuman: false, reason: `middle: ${risk ?? "unknown"} risk → auto-apply` };
  }
}

/** Best-effort read of review verdict + risk from accumulated agent tags (ISSUES I9). */
export function interpretWalk(tags: Record<string, string>): {
  reviewApproved: boolean;
  risk?: RiskLevel;
} {
  const decision = (tags.review_decision ?? tags.decision ?? tags.approved ?? "").toLowerCase();
  const reviewApproved = decision === "approve" || decision === "approved" || decision === "true";
  const rawRisk = (tags.risk ?? tags.risk_level ?? "").toLowerCase();
  const risk: RiskLevel | undefined =
    rawRisk === "low" || rawRisk === "medium" || rawRisk === "high" ? rawRisk : undefined;
  return { reviewApproved, risk };
}
