import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

// Repo root is one level up from tests/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(repoRoot, "scripts/check-configs.mjs");

/** Run the guard; return { code, out }. */
function runChecker(): { code: number; out: string } {
  try {
    const out = execFileSync("node", [script], { cwd: repoRoot, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("check-configs (routing-contract guard, issue #9)", () => {
  it("passes against the committed agent configs + graph", () => {
    const { code, out } = runChecker();
    assert.equal(code, 0, `check-configs failed:\n${out}`);
    assert.match(out, /passed/);
  });

  it("catches the invalid tag_conversation(key=…, value=…) signature", () => {
    // Failure-mode #1 from the issue: instructions calling the tool with the
    // wrong signature emit no tags. The guard's regex must flag that form.
    const bad = 'tag_conversation(key="needs_tests", value="true")';
    assert.match(bad, /tag_conversation\(\s*key\b[^)]*\)/);
    const good = 'tag_conversation({"tags": {"needs_tests": "true"}})';
    assert.doesNotMatch(good, /tag_conversation\(\s*key\b[^)]*\)/);
  });
});
