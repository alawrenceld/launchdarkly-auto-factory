import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DiscoveredFlag, LdClient } from "@auto-factory/shared";
import { triggerRelease } from "@auto-factory/beacon";

/** Minimal LdClient stub: boolean flags with fixed variation ids + call capture. */
function fakeLd(flags: Record<string, { onId: string; offId: string; on?: boolean }>) {
  const patches: Array<{ flagKey: string; instructions: Array<Record<string, unknown>> }> = [];
  const ld = {
    getFlag: async (key: string) => {
      const f = flags[key];
      if (!f) throw new Error(`no such flag ${key}`);
      return {
        status: 200,
        data: {
          variations: [
            { _id: f.onId, value: true },
            { _id: f.offId, value: false },
          ],
          environments: { production: { on: f.on ?? false } },
        },
      };
    },
    patchFlagSemantic: async (flagKey: string, _env: string, instructions: Array<Record<string, unknown>>) => {
      patches.push({ flagKey, instructions });
      return { status: 200, data: {} };
    },
    request: async () => {
      throw new Error("policy read not stubbed"); // getReleasePolicy is best-effort
    },
  } as unknown as LdClient;
  return { ld, patches };
}

const flag = (intent: unknown): DiscoveredFlag =>
  ({ flagKey: "enable-child", sourceFile: ".release-flags/pr-1.json", releaseIntent: intent }) as DiscoveredFlag;

describe("triggerRelease — releaseIntent handling", () => {
  it("action=hold → held, nothing patched", async () => {
    const { ld, patches } = fakeLd({ "enable-child": { onId: "on1", offId: "off1" } });
    const r = await triggerRelease(ld, flag({ action: "hold", notes: "waiting on marketing" }), "production");
    assert.equal(r.method, "held");
    assert.match(r.note ?? "", /action=hold/);
    assert.equal(patches.length, 0);
  });

  it("action=manual → held; unintelligible action → held (fail-closed)", async () => {
    const { ld } = fakeLd({ "enable-child": { onId: "on1", offId: "off1" } });
    assert.equal((await triggerRelease(ld, flag({ action: "manual" }), "production")).method, "held");
    assert.equal((await triggerRelease(ld, flag({ action: "??" }), "production")).method, "held");
  });

  it("future notBefore → held; segments ask → held (recorded, not executed)", async () => {
    const { ld } = fakeLd({ "enable-child": { onId: "on1", offId: "off1" } });
    const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
    assert.equal((await triggerRelease(ld, flag({ notBefore: future }), "production")).method, "held");
    assert.equal((await triggerRelease(ld, flag({ segments: ["beta"] }), "production")).method, "held");
  });

  it("prerequisites → LD-native: addPrerequisite + turnFlagOn, no automated release", async () => {
    const { ld, patches } = fakeLd({
      "enable-child": { onId: "childOn", offId: "childOff" },
      "flag-xyz": { onId: "parentOn", offId: "parentOff" },
    });
    const r = await triggerRelease(ld, flag({ prerequisites: [{ flagKey: "flag-xyz", variation: "on" }] }), "production");
    assert.equal(r.method, "prerequisites");
    assert.equal(patches.length, 1);
    const kinds = patches[0]!.instructions.map((i) => i.kind);
    assert.deepEqual(kinds, ["addPrerequisite", "turnFlagOn", "updateFallthroughVariationOrRollout"]);
    assert.equal(patches[0]!.instructions[0]!.key, "flag-xyz");
    assert.equal(patches[0]!.instructions[0]!.variationId, "parentOn");
    assert.equal(patches[0]!.instructions[2]!.variationId, "childOn");
  });

  it("missing prerequisite flag → held, nothing patched", async () => {
    const { ld, patches } = fakeLd({ "enable-child": { onId: "on1", offId: "off1" } });
    const r = await triggerRelease(ld, flag({ prerequisites: ["flag-nope"] }), "production");
    assert.equal(r.method, "held");
    assert.equal(patches.length, 0);
  });
});
