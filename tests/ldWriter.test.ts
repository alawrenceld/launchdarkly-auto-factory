import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LdResourceWriter, type LdClient } from "@auto-factory/shared";

/** Fake LdClient capturing the createFlag body and returning a scripted status. */
function fakeClient(status: number) {
  let lastBody: Record<string, unknown> | undefined;
  const client = {
    projectKey: "demo",
    createFlag: async (body: unknown) => {
      lastBody = body as Record<string, unknown>;
      return { status, data: {} };
    },
  } as unknown as LdClient;
  return { client, body: () => lastBody };
}

describe("LdResourceWriter.createBooleanFlag", () => {
  it("throws when key is missing", async () => {
    const { client } = fakeClient(201);
    const writer = new LdResourceWriter(client);
    await assert.rejects(() => writer.createBooleanFlag({ key: "" }), /flag key is required/);
  });

  it("reports created on a success status", async () => {
    const { client } = fakeClient(201);
    const r = await new LdResourceWriter(client).createBooleanFlag({ key: "enable-x" });
    assert.equal(r.created, true);
    assert.equal(r.alreadyExists, false);
    assert.equal(r.key, "enable-x");
    assert.match(r.detail, /Created flag 'enable-x'/);
  });

  it("reports alreadyExists on 409 (idempotent re-run)", async () => {
    const { client } = fakeClient(409);
    const r = await new LdResourceWriter(client).createBooleanFlag({ key: "enable-x" });
    assert.equal(r.created, false);
    assert.equal(r.alreadyExists, true);
    assert.match(r.detail, /already exists/);
  });

  it("merges + dedupes the standard auto-factory tags with caller tags", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k", tags: ["auto-factory", "custom"] });
    const tags = body()?.tags as string[];
    assert.deepEqual([...tags].sort(), ["auto-factory", "auto-generated", "custom"]);
  });

  it("sets the safe-default variation shape (on=treatment, off=control)", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k" });
    const b = body();
    assert.equal(b?.temporary, true);
    assert.deepEqual(b?.defaults, { onVariation: 0, offVariation: 1 });
  });
});
