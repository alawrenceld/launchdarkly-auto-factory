import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapModelParameters, mapToCursorModel, normalizeModelName } from "@auto-factory/shared";
import type { ModelListItem } from "@cursor/sdk";

const CATALOG: ModelListItem[] = [
  {
    id: "claude-4.6-sonnet",
    displayName: "Claude Sonnet 4.6",
    aliases: ["claude-sonnet-4-6"],
    parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "true" }, { value: "false" }] }],
  },
  { id: "composer-2.5", displayName: "Composer 2.5" },
  { id: "auto", displayName: "Auto" },
];

describe("normalizeModelName", () => {
  it("strips region + provider prefix and bedrock version suffix", () => {
    assert.equal(normalizeModelName("us.anthropic.claude-sonnet-4-6-v1:0"), "claude-sonnet-4-6");
  });
  it("normalizes punctuation so dotted and hyphenated ids align", () => {
    assert.equal(normalizeModelName("claude-4.6-sonnet"), "claude-4-6-sonnet");
  });
});

describe("mapToCursorModel", () => {
  it("matches the LD model name against a catalog alias (exact)", () => {
    const m = mapToCursorModel("claude-sonnet-4-6", CATALOG, "auto");
    assert.equal(m.id, "claude-4.6-sonnet");
    assert.equal(m.matched, true);
  });

  it("matches a Bedrock-qualified LD model name via normalization", () => {
    const m = mapToCursorModel("us.anthropic.claude-sonnet-4-6-v1:0", CATALOG, "auto");
    assert.equal(m.id, "claude-4.6-sonnet");
    assert.equal(m.matched, true);
  });

  it("falls back when there is no catalog match", () => {
    const m = mapToCursorModel("gpt-5", CATALOG, "composer-2.5");
    assert.equal(m.id, "composer-2.5");
    assert.equal(m.matched, false);
  });

  it("falls back when no LD model is configured", () => {
    const m = mapToCursorModel(undefined, CATALOG, "auto");
    assert.equal(m.id, "auto");
    assert.equal(m.matched, false);
  });
});

describe("mapModelParameters", () => {
  const modelDef = CATALOG[0];

  it("applies an LD param that matches a Cursor model parameter id", () => {
    const { params, dropped } = mapModelParameters({ fast: true }, modelDef);
    assert.deepEqual(params, [{ id: "fast", value: "true" }]);
    assert.deepEqual(dropped, []);
  });

  it("drops LD params with no Cursor equivalent (e.g. temperature/maxTokens)", () => {
    const { params, dropped } = mapModelParameters({ temperature: 0.2, maxTokens: 4096 }, modelDef);
    assert.deepEqual(params, []);
    assert.deepEqual(dropped.sort(), ["maxTokens", "temperature"]);
  });

  it("drops a value the model does not allow", () => {
    const { params, dropped } = mapModelParameters({ fast: "maybe" }, modelDef);
    assert.deepEqual(params, []);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0] ?? "", /fast=maybe/);
  });

  it("returns nothing when there are no LD params", () => {
    assert.deepEqual(mapModelParameters(undefined, modelDef), { params: [], dropped: [] });
  });
});
