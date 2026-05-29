import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { discoverNewReleaseFlags, type GitHubClient } from "@auto-factory/beacon";

/** Duck-typed fake GitHub client: pr-1 exists at both refs, pr-2 only at current. */
const fakeGh = {
  async listDir(_repo: unknown, _dir: string, ref: string): Promise<string[]> {
    return ref === "old" ? ["pr-1.json"] : ["pr-1.json", "pr-2.json", "notes.txt"];
  },
  async getFileJson(_repo: unknown, path: string): Promise<unknown> {
    if (path.endsWith("pr-2.json")) return { flagKey: "new-flag", scope: "backend" };
    return { flagKey: "old-flag" };
  },
} as unknown as GitHubClient;

describe("discoverNewReleaseFlags", () => {
  it("returns only files new at the current SHA (and only valid JSON release-flags)", async () => {
    const found = await discoverNewReleaseFlags(fakeGh, { owner: "o", name: "r" }, ".release-flags/", "new", "old");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.flagKey, "new-flag");
    assert.equal(found[0]?.scope, "backend");
    assert.equal(found[0]?.sourceFile, ".release-flags/pr-2.json");
  });

  it("treats everything as new when there is no previous SHA", async () => {
    const found = await discoverNewReleaseFlags(fakeGh, { owner: "o", name: "r" }, ".release-flags/", "new", undefined);
    // pr-1 + pr-2 are .json; notes.txt is ignored; pr-1 parses to a valid flag too
    assert.deepEqual(found.map((f) => f.flagKey).sort(), ["new-flag", "old-flag"]);
  });
});
