import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadReleaseSource, loadScopes, releaseFlagsDir } from "@auto-factory/shared";

// Tests run from the repo root, so config/*.yaml resolves.
describe("config loaders", () => {
  it("loads scope definitions including fullstack", () => {
    const cfg = loadScopes(process.cwd());
    assert.deepEqual(cfg.scopes.fullstack.services.sort(), ["backend", "frontend"]);
    assert.deepEqual(cfg.scopes.frontend.services, ["frontend"]);
  });

  it("loads the active release source and its directory", () => {
    const rs = loadReleaseSource(process.cwd());
    assert.equal(rs.active, "release-flags-dir");
    assert.equal(releaseFlagsDir(rs), ".release-flags/");
  });
});
