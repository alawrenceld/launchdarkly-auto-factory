import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { ApprovalPolicy } from "@auto-factory/shared";
import {
  DEFAULT_GATED_STEPS,
  createPolicyGate,
  normalizeApprovalMode,
  parseGateSteps,
  resolveApprovalPolicy,
  riskScoreOf,
} from "@auto-factory/shared";
import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";

const ctx: LDContext = { kind: "service", key: "test" };

/** Fake LDClient serving fixed flag values. */
function fakeLd(values: Record<string, unknown>): LDClient {
  return {
    variation: async (key: string, _c: unknown, def: unknown) => values[key] ?? def,
  } as unknown as LDClient;
}

const policy = (o: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  mode: "always",
  threshold: 0.6,
  steps: [{ step: "autofactory-flag-implementer" }],
  ...o,
});

afterEach(() => {
  delete process.env.APPROVAL_MODE;
  delete process.env.RISK_THRESHOLD;
  delete process.env.APPROVAL_GATES;
});

describe("normalizeApprovalMode", () => {
  it("maps legacy values", () => {
    assert.equal(normalizeApprovalMode("middle"), "risk-threshold");
    assert.equal(normalizeApprovalMode("manual"), "always");
  });
  it("passes current values and defaults unknown to yolo", () => {
    assert.equal(normalizeApprovalMode("risk-threshold"), "risk-threshold");
    assert.equal(normalizeApprovalMode("ALWAYS"), "always");
    assert.equal(normalizeApprovalMode("nonsense"), "yolo");
    assert.equal(normalizeApprovalMode(undefined), "yolo");
  });
});

describe("parseGateSteps (forward-compatible shape)", () => {
  it("accepts strings, objects, and a mix", () => {
    assert.deepEqual(parseGateSteps(["a", { step: "b", threshold: 0.4 }, { step: "c" }]), [
      { step: "a" },
      { step: "b", threshold: 0.4 },
      { step: "c" },
    ]);
  });
  it("drops junk entries and out-of-range thresholds", () => {
    assert.deepEqual(parseGateSteps([42, "", { nope: true }, { step: "x", threshold: 3 }]), [{ step: "x" }]);
    assert.deepEqual(parseGateSteps("not-an-array"), []);
  });
});

describe("riskScoreOf", () => {
  it("prefers the numeric risk_score", () => {
    assert.equal(riskScoreOf({ risk_score: "0.7", risk_level: "low" }), 0.7);
  });
  it("maps categorical risk_level when no score", () => {
    assert.equal(riskScoreOf({ risk_level: "low" }), 0.25);
    assert.equal(riskScoreOf({ risk_level: "medium" }), 0.5);
    assert.equal(riskScoreOf({ risk_level: "high" }), 0.75);
  });
  it("undefined when neither is usable (incl. out-of-range score)", () => {
    assert.equal(riskScoreOf({}), undefined);
    assert.equal(riskScoreOf({ risk_score: "7" }), undefined);
    assert.equal(riskScoreOf({ risk_score: "not-a-number" }), undefined);
  });
});

describe("resolveApprovalPolicy", () => {
  it("resolves the three flags", async () => {
    const p = await resolveApprovalPolicy(
      fakeLd({
        "auto-factory-approval-mode": "risk-threshold",
        "auto-factory-risk-threshold": 0.4,
        "auto-factory-approval-gates": ["autofactory-flag-implementer", { step: "autofactory-metrics-author", threshold: 0.8 }],
      }),
      ctx,
    );
    assert.equal(p.mode, "risk-threshold");
    assert.equal(p.threshold, 0.4);
    assert.deepEqual(p.steps, [
      { step: "autofactory-flag-implementer" },
      { step: "autofactory-metrics-author", threshold: 0.8 },
    ]);
  });

  it("defaults: yolo, 0.6", async () => {
    const p = await resolveApprovalPolicy(fakeLd({}), ctx);
    assert.equal(p.mode, "yolo");
    assert.equal(p.threshold, 0.6);
  });

  it("non-yolo mode with empty steps defaults to the implementer", async () => {
    const p = await resolveApprovalPolicy(fakeLd({ "auto-factory-approval-mode": "always" }), ctx);
    assert.deepEqual(
      p.steps.map((s) => s.step),
      [...DEFAULT_GATED_STEPS],
    );
  });

  it("env overrides win and legacy env values map", async () => {
    process.env.APPROVAL_MODE = "manual";
    process.env.RISK_THRESHOLD = "0.9";
    const p = await resolveApprovalPolicy(fakeLd({ "auto-factory-approval-mode": "yolo" }), ctx);
    assert.equal(p.mode, "always");
    assert.equal(p.threshold, 0.9);
  });

  it("clamps a bogus threshold into 0..1 (or default)", async () => {
    const p = await resolveApprovalPolicy(fakeLd({ "auto-factory-risk-threshold": 5 }), ctx);
    assert.equal(p.threshold, 1);
  });
});

describe("createPolicyGate (mode → gate compilation)", () => {
  it("yolo compiles to NO gate", () => {
    assert.equal(createPolicyGate(policy({ mode: "yolo" }), () => true), undefined);
  });

  it("always: every configured step asks for human approval", async () => {
    const asked: string[] = [];
    const gate = createPolicyGate(policy({ mode: "always" }), (n) => {
      asked.push(n);
      return false;
    });
    assert.ok(gate);
    assert.deepEqual(gate.steps, ["autofactory-flag-implementer"]);
    assert.equal(await gate.resolve("autofactory-flag-implementer", {}), false);
    assert.deepEqual(asked, ["autofactory-flag-implementer"]);
  });

  it("risk-threshold: below threshold proceeds WITHOUT asking a human", async () => {
    const asked: string[] = [];
    const gate = createPolicyGate(policy({ mode: "risk-threshold", threshold: 0.6 }), (n) => {
      asked.push(n);
      return false;
    });
    assert.equal(await gate!.resolve("autofactory-flag-implementer", { risk_score: "0.3" }), true);
    assert.deepEqual(asked, []);
  });

  it("risk-threshold: at/above threshold requires the human", async () => {
    const gate = createPolicyGate(policy({ mode: "risk-threshold", threshold: 0.6 }), () => false);
    assert.equal(await gate!.resolve("autofactory-flag-implementer", { risk_score: "0.7" }), false);
    assert.equal(await gate!.resolve("autofactory-flag-implementer", { risk_score: "0.6" }), false);
  });

  it("risk-threshold: UNKNOWN risk fails closed (requires the human)", async () => {
    const gate = createPolicyGate(policy({ mode: "risk-threshold" }), () => false);
    assert.equal(await gate!.resolve("autofactory-flag-implementer", {}), false);
  });

  it("risk-threshold: categorical fallback maps (high=0.75 ≥ 0.6 → gate)", async () => {
    const gate = createPolicyGate(policy({ mode: "risk-threshold", threshold: 0.6 }), () => false);
    assert.equal(await gate!.resolve("autofactory-flag-implementer", { risk_level: "high" }), false);
    assert.equal(await gate!.resolve("autofactory-flag-implementer", { risk_level: "low" }), true);
  });

  it("per-step threshold overrides the blanket", async () => {
    const gate = createPolicyGate(
      policy({
        mode: "risk-threshold",
        threshold: 0.6,
        steps: [{ step: "autofactory-flag-implementer", threshold: 0.2 }, { step: "autofactory-metrics-author" }],
      }),
      () => false,
    );
    // 0.3 ≥ per-step 0.2 → gated, even though it's below the blanket 0.6.
    assert.equal(await gate!.resolve("autofactory-flag-implementer", { risk_score: "0.3" }), false);
    // Same risk on the step WITHOUT an override → below blanket → proceeds.
    assert.equal(await gate!.resolve("autofactory-metrics-author", { risk_score: "0.3" }), true);
  });

  it("approved human gate resolves true in either mode", async () => {
    const alwaysGate = createPolicyGate(policy({ mode: "always" }), () => true);
    assert.equal(await alwaysGate!.resolve("autofactory-flag-implementer", {}), true);
    const riskGate = createPolicyGate(policy({ mode: "risk-threshold" }), () => true);
    assert.equal(await riskGate!.resolve("autofactory-flag-implementer", { risk_score: "0.9" }), true);
  });
});
