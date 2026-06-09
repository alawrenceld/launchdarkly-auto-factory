import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveGrant } from "@auto-factory/shared";

describe("resolveGrant", () => {
  it("uses edge capabilities when present (source=edge)", () => {
    const r = resolveGrant("anything", ["create_flag", "edit_files"]);
    assert.deepEqual(r.grant, { createFlag: true, editFiles: true });
    assert.equal(r.source, "edge");
  });

  it("an empty edge list grants nothing (still source=edge, overrides fallback)", () => {
    const r = resolveGrant("autofactory-flag-implementer", []);
    assert.deepEqual(r.grant, { createFlag: false, editFiles: false });
    assert.equal(r.source, "edge");
  });

  it("partial edge list grants only what's listed", () => {
    const r = resolveGrant("autofactory-flag-testing", ["edit_files"]);
    assert.deepEqual(r.grant, { createFlag: false, editFiles: true });
  });

  it("falls back to NODE_CAPABILITIES by config key when no edge list (source=fallback)", () => {
    const impl = resolveGrant("autofactory-flag-implementer", undefined);
    assert.deepEqual(impl.grant, { createFlag: true, editFiles: true });
    assert.equal(impl.source, "fallback");

    const testing = resolveGrant("autofactory-flag-testing", undefined);
    assert.deepEqual(testing.grant, { createFlag: false, editFiles: true });
    assert.equal(testing.source, "fallback");
  });

  it("read-only (source=none) for an unknown key with no edge list", () => {
    const r = resolveGrant("autofactory-research-planner", undefined);
    assert.deepEqual(r.grant, { createFlag: false, editFiles: false });
    assert.equal(r.source, "none");
  });
});
