import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { computeConfigHash, extractConfigStamp, stampDescription } from "@auto-factory/shared";

const root = mkdtempSync(join(tmpdir(), "cfgver-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function makeDirs(name: string, files: Record<string, string> = {}) {
  const base = join(root, name);
  const dirs = {
    aiConfigsDir: join(base, "ai-configs"),
    graphsDir: join(base, "graphs"),
    flagsDir: join(base, "flags"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(base, rel), content);
  }
  return dirs;
}

describe("computeConfigHash", () => {
  it("is stable for identical content regardless of directory location", () => {
    const a = makeDirs("a", { "ai-configs/x.json": '{"key":"x"}', "graphs/g.json": '{"key":"g"}' });
    const b = makeDirs("b", { "ai-configs/x.json": '{"key":"x"}', "graphs/g.json": '{"key":"g"}' });
    assert.equal(computeConfigHash(a), computeConfigHash(b));
    assert.match(computeConfigHash(a)!, /^[0-9a-f]{12}$/);
  });

  it("changes when any file's content, name, or subdir changes", () => {
    const base = computeConfigHash(makeDirs("c1", { "ai-configs/x.json": '{"v":1}' }));
    assert.notEqual(base, computeConfigHash(makeDirs("c2", { "ai-configs/x.json": '{"v":2}' })));
    assert.notEqual(base, computeConfigHash(makeDirs("c3", { "ai-configs/y.json": '{"v":1}' })));
    assert.notEqual(base, computeConfigHash(makeDirs("c4", { "flags/x.json": '{"v":1}' })));
  });

  it("returns undefined when no config files exist (e.g. no repo checkout)", () => {
    assert.equal(computeConfigHash(makeDirs("empty")), undefined);
    assert.equal(
      computeConfigHash({ aiConfigsDir: "/nope", graphsDir: "/nope", flagsDir: "/nope" }),
      undefined,
    );
  });
});

describe("stampDescription / extractConfigStamp", () => {
  it("round-trips, replaces an existing stamp, and preserves the description", () => {
    const h1 = "abcdefabcdef";
    const h2 = "123456123456";
    const stamped = stampDescription("My pipeline graph", h1);
    assert.equal(stamped, "My pipeline graph [cfg:abcdefabcdef]");
    assert.equal(extractConfigStamp(stamped), h1);
    const restamped = stampDescription(stamped, h2);
    assert.equal(restamped, "My pipeline graph [cfg:123456123456]");
    assert.equal(extractConfigStamp(restamped), h2);
  });

  it("handles empty/undefined descriptions", () => {
    assert.equal(stampDescription(undefined, "abcdefabcdef"), "[cfg:abcdefabcdef]");
    assert.equal(stampDescription("", "abcdefabcdef"), "[cfg:abcdefabcdef]");
    assert.equal(extractConfigStamp(undefined), undefined);
    assert.equal(extractConfigStamp("no marker here"), undefined);
  });
});
