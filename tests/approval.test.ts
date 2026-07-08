import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WalkVerdict } from "@auto-factory/shared";
import { decideApproval, interpretWalk } from "@auto-factory/shared";

/** Build a WalkVerdict with safe defaults (no verdict, no skip). */
const verdict = (o: Partial<WalkVerdict> = {}): WalkVerdict => ({
  reviewApproved: false,
  hasVerdict: false,
  skipFlagging: false,
  ...o,
});

describe("decideApproval (verdict-only — approvals happen pre-execution via gates)", () => {
  it("approves when the reviewer approved", () => {
    const d = decideApproval(verdict({ hasVerdict: true, reviewApproved: true }));
    assert.equal(d.apply, true);
    assert.equal(d.noop, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /approved/i);
  });

  it("rejects only when a verdict WAS recorded and was negative", () => {
    const d = decideApproval(verdict({ hasVerdict: true, reviewApproved: false }));
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /reject/i);
  });

  it("reports INCOMPLETE (not a rejection) when NO verdict was recorded", () => {
    const d = decideApproval(verdict({ hasVerdict: false }));
    assert.equal(d.incomplete, true);
    assert.equal(d.apply, false);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("skip_flagging is a successful no-op regardless of verdict", () => {
    const d = decideApproval(verdict({ skipFlagging: true }));
    assert.equal(d.noop, true);
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.doesNotMatch(d.reason, /reject/i);
  });
});

describe("interpretWalk", () => {
  it("reads the canonical review_approved / risk_level tags", () => {
    const v = interpretWalk({ review_approved: "true", risk_level: "high" });
    assert.equal(v.hasVerdict, true);
    assert.equal(v.reviewApproved, true);
    assert.equal(v.risk, "high");
  });

  it("accepts approve/approved verdict spellings", () => {
    for (const val of ["approve", "approved", "true"]) {
      assert.equal(interpretWalk({ review_approved: val }).reviewApproved, true, val);
    }
    assert.equal(interpretWalk({ review_approved: "reject" }).reviewApproved, false);
  });

  it("falls back to legacy tag names", () => {
    assert.equal(interpretWalk({ review_decision: "approve" }).reviewApproved, true);
    assert.equal(interpretWalk({ decision: "approved" }).reviewApproved, true);
    assert.equal(interpretWalk({ risk: "medium" }).risk, "medium");
  });

  it("no verdict tags at all → hasVerdict false", () => {
    const v = interpretWalk({ flag_created: "true" });
    assert.equal(v.hasVerdict, false);
  });

  it("reads skip_flagging", () => {
    assert.equal(interpretWalk({ skip_flagging: "true" }).skipFlagging, true);
    assert.equal(interpretWalk({}).skipFlagging, false);
  });
});
