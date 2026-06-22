import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { LDClient, LDContext } from "@launchdarkly/node-server-sdk";
import { APPROVAL_GATES_FLAG_KEY, resolveApprovalGates } from "@auto-factory/shared";

const ctx = { kind: "service", key: "test" } as LDContext;

/** Fake LD client returning a fixed flag value. */
function fakeClient(value: unknown): LDClient {
  return { async variation(_k: string, _c: LDContext, _d: unknown) { return value; } } as unknown as LDClient;
}

describe("resolveApprovalGates", () => {
  const orig = process.env.APPROVAL_GATES;
  afterEach(() => {
    if (orig === undefined) delete process.env.APPROVAL_GATES;
    else process.env.APPROVAL_GATES = orig;
  });

  it("reads a JSON array of node keys from the flag", async () => {
    delete process.env.APPROVAL_GATES;
    const steps = await resolveApprovalGates(fakeClient(["autofactory-flag-implementer"]), ctx);
    assert.deepEqual(steps, ["autofactory-flag-implementer"]);
  });

  it("defaults to no gates when the flag value is absent/non-array", async () => {
    delete process.env.APPROVAL_GATES;
    assert.deepEqual(await resolveApprovalGates(fakeClient(undefined), ctx), []);
    assert.deepEqual(await resolveApprovalGates(fakeClient("nonsense"), ctx), []);
    assert.deepEqual(await resolveApprovalGates(fakeClient([1, 2, ""]), ctx), []); // drops non-strings/empty
  });

  it("APPROVAL_GATES env overrides the flag (JSON array form)", async () => {
    process.env.APPROVAL_GATES = '["autofactory-metrics-author"]';
    const steps = await resolveApprovalGates(fakeClient(["from-flag"]), ctx);
    assert.deepEqual(steps, ["autofactory-metrics-author"]);
  });

  it("APPROVAL_GATES env also accepts a comma-separated list", async () => {
    process.env.APPROVAL_GATES = "autofactory-flag-implementer, autofactory-metrics-author";
    const steps = await resolveApprovalGates(fakeClient([]), ctx);
    assert.deepEqual(steps, ["autofactory-flag-implementer", "autofactory-metrics-author"]);
  });

  it("exports the canonical flag key", () => {
    assert.equal(APPROVAL_GATES_FLAG_KEY, "auto-factory-approval-gates");
  });
});
