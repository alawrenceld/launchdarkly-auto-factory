/**
 * Post-walk verdict interpretation.
 *
 * This module used to also hold the approval-MODE logic (yolo/middle/manual as
 * a post-hoc decision). That was theater: by the time the walk finishes, the
 * flags exist and the commits are pushed — there is nothing left to "apply".
 * Human approval now happens where it can still prevent side effects:
 * pre-execution gates, compiled from the approval-mode + risk-threshold +
 * approval-gates flags (see approvalPolicy.ts). What remains here is reading
 * the reviewer's verdict from the accumulated tags and turning it into the
 * run's reported outcome (green/red/no-op/incomplete).
 *
 * The DECISION logic is firm. How the verdict/risk are read from agent tags is
 * best-effort: the canonical tags are `review_approved` / `risk_level`, but
 * `interpretWalk` also accepts a few legacy keys for resilience.
 */

import type { RiskLevel } from "./types.js";

export interface ApprovalDecision {
  /** The reviewer approved — the run reports success. */
  apply: boolean;
  /**
   * True when the pipeline intentionally created no flag (e.g. an infra/docs PR
   * that hit Rule F11). There is nothing to review or apply, so this is a
   * successful no-op — NOT a rejection. The PR check should pass.
   */
  noop: boolean;
  /**
   * True when the chain produced NO review verdict — the code reviewer never ran
   * (the chain stalled on an unmet handoff, or stopped early). Distinct from a
   * rejection: the reviewer did not reject, it never got to weigh in. Surfaced
   * as its own outcome so a stall is not misreported as "REJECTED" (issue #9).
   */
  incomplete: boolean;
  reason: string;
}

/** The review verdict + routing signals read from the accumulated agent tags. */
export interface WalkVerdict {
  /** The reviewer approved (an explicit approve/approved/true verdict). */
  reviewApproved: boolean;
  /**
   * An explicit review verdict tag was present at all. False means no verdict
   * was recorded (reviewer never ran) — which is INCOMPLETE, not a rejection.
   */
  hasVerdict: boolean;
  risk?: RiskLevel;
  /** The research planner declared no flag is needed (Rule F11). */
  skipFlagging: boolean;
}

/** Turn the reviewer's verdict into the run's reported outcome. */
export function decideApproval(verdict: WalkVerdict): ApprovalDecision {
  const base = { apply: false, noop: false, incomplete: false };

  if (verdict.skipFlagging) {
    return { ...base, noop: true, reason: "no flag needed — nothing to review" };
  }
  if (!verdict.hasVerdict) {
    return { ...base, incomplete: true, reason: "INCOMPLETE — the code reviewer never produced a verdict" };
  }
  if (!verdict.reviewApproved) {
    return { ...base, reason: "code review REJECTED" };
  }
  return { ...base, apply: true, reason: "code review APPROVED" };
}

/**
 * Read the review verdict + risk from accumulated agent tags. The canonical tags
 * the code reviewer emits are `review_approved` and `risk_level` (documented in
 * config/agentcontrol/README.md and config/agentcontrol/tags.json); the
 * additional keys are LEGACY fallbacks kept only for resilience against older
 * config variations.
 */
export function interpretWalk(tags: Record<string, string>): WalkVerdict {
  const rawDecision = (
    tags.review_approved ?? // canonical
    tags.review_decision ?? // legacy
    tags.decision ?? // legacy
    tags.approved ?? // legacy
    ""
  ).toLowerCase();
  const hasVerdict = rawDecision !== "";
  const reviewApproved = rawDecision === "approve" || rawDecision === "approved" || rawDecision === "true";
  const rawRisk = (
    tags.risk_level ?? // canonical
    tags.risk ?? // legacy
    ""
  ).toLowerCase();
  const risk: RiskLevel | undefined =
    rawRisk === "low" || rawRisk === "medium" || rawRisk === "high" ? rawRisk : undefined;
  const skipFlagging = (tags.skip_flagging ?? "").toLowerCase() === "true";
  return { reviewApproved, hasVerdict, risk, skipFlagging };
}
