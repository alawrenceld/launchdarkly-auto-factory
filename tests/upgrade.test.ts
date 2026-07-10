import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { LdClient } from "@auto-factory/shared";
import { upgrade } from "@auto-factory/config-bridge";

/** Fake LdClient capturing writes; live state provided per-test. */
function fakeLd(liveState: {
  configs?: Record<string, { variations: Array<Record<string, unknown>> }>;
  graphs?: Record<string, { rootConfigKey?: string; edges?: unknown[] }>;
  flags?: Record<string, { variations?: Array<{ value: unknown }> }>;
}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const rec = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    return Promise.resolve({ status: 201, ok: true, data: {} });
  };
  const ld = {
    projectKey: "test-proj",
    getAiConfig: async (key: string) => {
      const c = liveState.configs?.[key];
      return c ? { status: 200, ok: true, data: c } : { status: 404, ok: true, data: {} };
    },
    getAgentGraph: async (key: string) => {
      const g = liveState.graphs?.[key];
      return g ? { status: 200, ok: true, data: g } : { status: 404, ok: true, data: {} };
    },
    request: async (opts: { path: string }) => {
      const key = opts.path.split("/").pop()!;
      const f = liveState.flags?.[key];
      return f ? { status: 200, ok: true, data: f } : { status: 404, ok: true, data: {} };
    },
    createAiConfig: rec("createAiConfig"),
    createAiConfigVariation: rec("createAiConfigVariation"),
    updateAiConfigVariation: rec("updateAiConfigVariation"),
    createAgentGraph: rec("createAgentGraph"),
    updateAgentGraph: rec("updateAgentGraph"),
    createFlag: rec("createFlag"),
  } as unknown as LdClient;
  return { ld, calls };
}

const root = mkdtempSync(join(tmpdir(), "upgrade-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function writeDirs(name: string, files: { configs?: Record<string, unknown>; graphs?: Record<string, unknown>; flags?: Record<string, unknown> }) {
  const base = join(root, name);
  for (const [sub, entries] of [["ai-configs", files.configs], ["graphs", files.graphs], ["flags", files.flags]] as const) {
    mkdirSync(join(base, sub), { recursive: true });
    for (const [key, body] of Object.entries(entries ?? {})) {
      writeFileSync(join(base, sub, `${key}.json`), JSON.stringify(body));
    }
  }
  return {
    aiConfigsDir: join(base, "ai-configs"),
    graphsDir: join(base, "graphs"),
    flagsDir: join(base, "flags"),
  };
}

describe("bridge upgrade", () => {
  it("updates drifted instructions, followed by the no-op modelConfigKey re-patch", async () => {
    const dirs = writeDirs("instr", {
      configs: {
        "cfg-a": {
          key: "cfg-a", name: "A",
          variations: [{ key: "v1", instructions: "NEW instructions", modelConfigKey: "sonnet-46" }],
        },
      },
    });
    const { ld, calls } = fakeLd({
      configs: { "cfg-a": { variations: [{ key: "v1", instructions: "OLD instructions", modelConfigKey: "sonnet-46" }] } },
    });
    const r = await upgrade(ld, dirs);
    assert.deepEqual(r.variationsUpdated, ["cfg-a/v1 (instructions)"]);
    const patches = calls.filter((c) => c.op === "updateAiConfigVariation");
    assert.equal(patches.length, 2);
    assert.equal((patches[0]!.args[2] as { instructions: string }).instructions, "NEW instructions");
    // Cost workaround: second PATCH is modelConfigKey-only, echoing the LIVE key.
    const second = patches[1]!.args[2] as Record<string, unknown>;
    assert.equal(second.modelConfigKey, "sonnet-46");
    assert.equal(second.instructions, undefined);
  });

  it("no content diff → no PATCHes; live model differences are drift, never overwritten", async () => {
    const dirs = writeDirs("model", {
      configs: {
        "cfg-a": {
          key: "cfg-a", name: "A",
          variations: [{ key: "v1", instructions: "same", modelConfigKey: "sonnet-46" }],
        },
      },
    });
    const { ld, calls } = fakeLd({
      configs: { "cfg-a": { variations: [{ key: "v1", instructions: "same", modelConfigKey: "composer-1" }] } },
    });
    const r = await upgrade(ld, dirs);
    assert.equal(calls.filter((c) => c.op === "updateAiConfigVariation").length, 0);
    assert.equal(r.drift.length, 1);
    assert.match(r.drift[0]!, /model differs/);
  });

  it("creates missing configs/variations via provision; extra live variations untouched", async () => {
    const dirs = writeDirs("create", {
      configs: {
        "cfg-new": { key: "cfg-new", name: "New", variations: [{ key: "v1", instructions: "x" }] },
        "cfg-old": { key: "cfg-old", name: "Old", variations: [{ key: "v1", instructions: "x" }] },
      },
    });
    const { ld, calls } = fakeLd({
      configs: {
        "cfg-old": {
          variations: [
            { key: "v1", instructions: "x" },
            { key: "composer-arm", instructions: "live-only A/B arm" }, // repo doesn't know this one
          ],
        },
      },
    });
    const r = await upgrade(ld, dirs);
    assert.deepEqual(r.provision.configsCreated, ["cfg-new"]);
    assert.deepEqual(r.variationsUpdated, []);
    // Nothing ever writes to the live-only variation.
    for (const c of calls.filter((c) => c.op === "updateAiConfigVariation")) {
      assert.notEqual(c.args[1], "composer-arm");
    }
  });

  it("full-object PATCHes a graph whose edges drifted; ignores live-only metadata", async () => {
    const committedGraph = {
      key: "g1", name: "G",
      rootConfigKey: "research",
      edges: [{ key: "e1", sourceConfig: "research", targetConfig: "steward", handoff: { max_turns: 8 } }],
    };
    const dirs = writeDirs("graph", { graphs: { g1: committedGraph } });

    // Same owned shape, plus API metadata → NO update.
    const same = fakeLd({
      graphs: { g1: { rootConfigKey: "research", edges: [{ key: "e1", sourceConfig: "research", targetConfig: "steward", handoff: { max_turns: 8 } }], _links: {}, version: 3 } as never },
    });
    assert.deepEqual((await upgrade(same.ld, dirs)).graphsUpdated, []);

    // Drifted handoff → full-object PATCH.
    const drifted = fakeLd({
      graphs: { g1: { rootConfigKey: "research", edges: [{ key: "e1", sourceConfig: "research", targetConfig: "implementer", handoff: {} }] } },
    });
    const r = await upgrade(drifted.ld, dirs);
    assert.deepEqual(r.graphsUpdated, ["g1"]);
    const patch = drifted.calls.find((c) => c.op === "updateAgentGraph")!;
    assert.equal(patch.args[0], "g1");
    assert.deepEqual((patch.args[1] as { edges: unknown[] }).edges, committedGraph.edges);
  });

  it("existing flags: value drift reported, never written; missing flags created", async () => {
    const dirs = writeDirs("flags", {
      flags: {
        "flag-live": { key: "flag-live", name: "Live", variations: [{ value: "a" }, { value: "b" }] },
        "flag-missing": { key: "flag-missing", name: "Missing", variations: [{ value: true }, { value: false }] },
      },
    });
    const { ld, calls } = fakeLd({
      flags: { "flag-live": { variations: [{ value: "a" }, { value: "b" }, { value: "c" }] } },
    });
    const r = await upgrade(ld, dirs);
    assert.deepEqual(r.provision.flagsCreated, ["flag-missing"]);
    assert.equal(calls.filter((c) => c.op === "createFlag").length, 1);
    assert.equal(r.drift.length, 1);
    assert.match(r.drift[0]!, /flag flag-live/);
  });

  it("dry run performs zero writes but reports the full plan", async () => {
    const dirs = writeDirs("dry", {
      configs: { "cfg-a": { key: "cfg-a", name: "A", variations: [{ key: "v1", instructions: "NEW" }] } },
      graphs: { g1: { key: "g1", name: "G", rootConfigKey: "a", edges: [] } },
    });
    const { ld, calls } = fakeLd({
      configs: { "cfg-a": { variations: [{ key: "v1", instructions: "OLD" }] } },
      graphs: { g1: { rootConfigKey: "b", edges: [] } },
    });
    const r = await upgrade(ld, { ...dirs, dryRun: true });
    assert.deepEqual(r.variationsUpdated, ["cfg-a/v1 (instructions)"]);
    assert.deepEqual(r.graphsUpdated, ["g1"]);
    assert.equal(calls.length, 0);
  });

  it("attaches a committed judgeConfiguration the live variation lacks", async () => {
    const judge = { judges: [{ configKey: "judge-x", samplingRate: 0.5 }] };
    const dirs = writeDirs("judge", {
      configs: { "cfg-a": { key: "cfg-a", name: "A", variations: [{ key: "v1", instructions: "same", judgeConfiguration: judge }] } },
    });
    const { ld, calls } = fakeLd({
      configs: { "cfg-a": { variations: [{ key: "v1", instructions: "same", modelConfigKey: "m1" }] } },
    });
    const r = await upgrade(ld, dirs);
    assert.deepEqual(r.variationsUpdated, ["cfg-a/v1 (judgeConfiguration)"]);
    const patches = calls.filter((c) => c.op === "updateAiConfigVariation");
    assert.equal(patches.length, 2); // content patch + cost re-patch
    assert.deepEqual((patches[0]!.args[2] as { judgeConfiguration: unknown }).judgeConfiguration, judge);
  });
});
