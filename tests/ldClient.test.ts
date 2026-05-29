import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LdApiError, LdClient } from "@auto-factory/shared";

const conn = { apiKey: "tok-123", baseUrl: "https://ld.example", projectKey: "p" };

function withFetch(impl: typeof fetch): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = orig;
  };
}

describe("LdClient", () => {
  it("sends the raw Authorization header and parses JSON", async () => {
    let capturedUrl = "";
    let capturedAuth: unknown;
    const restore = withFetch((async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ key: "f" }), { status: 200 });
    }) as unknown as typeof fetch);

    const res = await new LdClient(conn).getFlag<{ key: string }>("f");
    restore();

    assert.equal(res.status, 200);
    assert.equal(res.data.key, "f");
    assert.equal(capturedAuth, "tok-123");
    assert.ok(capturedUrl.includes("/api/v2/flags/p/f"));
  });

  it("treats 409 as ok for createFlag (okStatuses)", async () => {
    const restore = withFetch((async () => new Response("{}", { status: 409 })) as unknown as typeof fetch);
    const res = await new LdClient(conn).createFlag({ key: "f" });
    restore();
    assert.equal(res.status, 409);
    assert.equal(res.ok, true);
  });

  it("throws LdApiError on an unexpected error status", async () => {
    const restore = withFetch((async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
    await assert.rejects(() => new LdClient(conn).getFlag("f"), (e: unknown) => {
      assert.ok(e instanceof LdApiError);
      assert.equal((e as LdApiError).status, 500);
      return true;
    });
    restore();
  });

  it("sends the semantic-patch content-type for flag patches", async () => {
    let ct: unknown;
    const restore = withFetch((async (_url: string, init: RequestInit) => {
      ct = (init.headers as Record<string, string>)["Content-Type"];
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    await new LdClient(conn).patchFlagSemantic("f", "production", [{ kind: "turnFlagOn" }]);
    restore();
    assert.match(String(ct), /domain-model=launchdarkly\.semanticpatch/);
  });
});
