import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SandboxToolExecutor, buildSandboxTools, normalizeLdDocsUrl, resolveGrant } from "@auto-factory/shared";

describe("read_ld_docs: URL normalization + allowlist", () => {
  const ok = (input: string, expected: string) => {
    const r = normalizeLdDocsUrl(input);
    assert.deepEqual(r, { url: expected }, input);
  };
  const rejected = (input: string, why: RegExp) => {
    const r = normalizeLdDocsUrl(input);
    assert.ok("error" in r, `expected rejection for '${input}'`);
    assert.match(r.error, why);
  };

  it("normalizes bare paths, /docs prefixes, and full URLs to .md", () => {
    ok("sdk/features/events", "https://launchdarkly.com/docs/sdk/features/events.md");
    ok("/docs/home/releases/guarded-rollouts", "https://launchdarkly.com/docs/home/releases/guarded-rollouts.md");
    ok("https://launchdarkly.com/docs/home/metrics/choose", "https://launchdarkly.com/docs/home/metrics/choose.md");
    ok("home/metrics/custom-metrics.md", "https://launchdarkly.com/docs/home/metrics/custom-metrics.md");
    ok("sdk/features/all-flags/", "https://launchdarkly.com/docs/sdk/features/all-flags.md");
  });

  it("passes llms.txt through as the directory", () => {
    ok("llms.txt", "https://launchdarkly.com/docs/llms.txt");
    ok("https://launchdarkly.com/docs/llms.txt", "https://launchdarkly.com/docs/llms.txt");
  });

  it("strips query strings and fragments", () => {
    ok("sdk/features/events?tab=python#section", "https://launchdarkly.com/docs/sdk/features/events.md");
  });

  it("rejects other hosts, traversal, and junk", () => {
    rejected("https://example.com/docs/anything", /only launchdarkly\.com/);
    rejected("https://launchdarkly.com.evil.io/docs/x", /only launchdarkly\.com/);
    rejected("../../etc/passwd", /invalid path/);
    rejected("", /empty/);
    rejected("docs/", /empty docs path/);
    rejected("sdk/features/ev ents", /invalid characters/);
  });
});

describe("read_ld_docs: capability gating", () => {
  it("is offered only with readDocs", () => {
    const withDocs = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false, readDocs: true });
    assert.ok(withDocs.some((t) => t.name === "read_ld_docs"));
    const without = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false });
    assert.ok(!without.some((t) => t.name === "read_ld_docs"));
  });

  it("read_docs edge token and fallback grants resolve", () => {
    assert.equal(resolveGrant("anything", ["read_docs"]).grant.readDocs, true);
    assert.equal(resolveGrant("anything", ["edit_files"]).grant.readDocs, false);
    // fallback map: metrics author, implementer, reviewer get docs; testing doesn't
    assert.equal(resolveGrant("autofactory-metrics-author", undefined).grant.readDocs, true);
    assert.equal(resolveGrant("autofactory-flag-implementer", undefined).grant.readDocs, true);
    assert.equal(resolveGrant("autofactory-code-reviewer", undefined).grant.readDocs, true);
    assert.equal(resolveGrant("autofactory-flag-testing", undefined).grant.readDocs ?? false, false);
  });

  it("executor rejects disallowed paths without fetching", async () => {
    const executor = new SandboxToolExecutor(process.cwd());
    const r = await executor.execute("read_ld_docs", { path: "https://example.com/docs/x" });
    assert.equal(r.isError, true);
    assert.match(r.content, /only launchdarkly\.com/);
  });
});
