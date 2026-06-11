import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRailwayWebhook } from "@auto-factory/beacon";

describe("parseRailwayWebhook", () => {
  it("parses the live 2026 layout (captured from a real delivery)", () => {
    // Abridged verbatim from a real Railway delivery, 2026-06-11.
    const result = parseRailwayWebhook({
      type: "Deployment.deployed",
      details: {
        id: "c440d267-5917-4e72-b5e6-bdf38112d353",
        branch: "main",
        source: "GitHub",
        status: "SUCCESS",
        builder: "RAILPACK",
        serviceId: "4c5ad7d9-f911-4abd-ab4d-ebe414d16074",
        commitHash: "d21f6e5173405f5005b38cddd3e42e7237311f93",
        repoSource: "ttotenberg-ld/launchdarkly-autofactory-demo",
      },
      resource: {
        project: { id: "cd0547d8", name: "resplendent-enjoyment" },
        service: { id: "4c5ad7d9", name: "demo-frontend" },
        deployment: { id: "c440d267" },
        environment: { id: "392e31fd", name: "production", isEphemeral: false },
      },
      severity: "INFO",
      timestamp: "2026-06-11T20:22:49.000Z",
    });
    assert.deepEqual(result, {
      kind: "deploy_success",
      service: "demo-frontend",
      sha: "d21f6e5173405f5005b38cddd3e42e7237311f93",
      railwayEnvironment: "production",
    });
  });

  it("parses a successful deploy (older layout)", () => {
    const result = parseRailwayWebhook({
      type: "DEPLOY",
      status: "SUCCESS",
      service: { id: "s1", name: "demo-backend" },
      environment: { id: "e1", name: "production" },
      deployment: { id: "d1", meta: { commitHash: "abc123", branch: "main" } },
    });
    assert.deepEqual(result, {
      kind: "deploy_success",
      service: "demo-backend",
      sha: "abc123",
      railwayEnvironment: "production",
    });
  });

  it("parses alternate field placements (status/meta nested differently)", () => {
    const result = parseRailwayWebhook({
      deployment: { status: "SUCCESS", meta: { commitSha: "def456", serviceName: "demo-frontend" } },
    });
    assert.deepEqual(result, { kind: "deploy_success", service: "demo-frontend", sha: "def456" });
  });

  it("accepts DEPLOYED/REDEPLOYED as success statuses (webhook event spellings)", () => {
    for (const status of ["DEPLOYED", "Redeployed"]) {
      const result = parseRailwayWebhook({
        status,
        service: { name: "demo-backend" },
        deployment: { meta: { commitHash: "abc" } },
      });
      assert.equal(result.kind, "deploy_success", `status ${status}`);
    }
  });

  it("ignores non-success deploy events", () => {
    for (const status of ["BUILDING", "FAILED", "CRASHED", "REMOVED", "QUEUED"]) {
      const result = parseRailwayWebhook({ status, service: { name: "demo-backend" } });
      assert.equal(result.kind, "ignored", `status ${status}`);
    }
  });

  it("reports unrecognized payloads without throwing", () => {
    assert.equal(parseRailwayWebhook(null).kind, "unrecognized");
    assert.equal(parseRailwayWebhook("nope").kind, "unrecognized");
    assert.equal(parseRailwayWebhook({ hello: "world" }).kind, "unrecognized");
    // SUCCESS but no way to identify the service/commit.
    assert.equal(parseRailwayWebhook({ status: "SUCCESS" }).kind, "unrecognized");
  });
});
