/**
 * Preflight checks for bootstrap: Node version, LD connection env, and that the
 * target LaunchDarkly project is reachable + the key is authorized.
 * Imported dynamically by create.mjs (after the workspace is built).
 */

import { LdClient, targetConnection } from "@auto-factory/shared";

export async function preflight() {
  const ok = [];
  const issues = [];
  const notes = [];

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok.push(`Node ${process.versions.node}`);
  else issues.push(`Node >= 20 required (have ${process.versions.node})`);

  let conn = null;
  try {
    conn = targetConnection();
    ok.push(`Target: project '${conn.projectKey}' @ ${conn.baseUrl}`);
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }

  if (conn) {
    try {
      const ld = new LdClient(conn);
      await ld.request({ path: `/api/v2/projects/${conn.projectKey}` });
      ok.push("LaunchDarkly API reachable + authorized");
    } catch (e) {
      issues.push(`LaunchDarkly API check failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  for (const k of ["GITHUB_TOKEN", "BEACON_WEBHOOK_SECRET"]) {
    if (!process.env[k]) notes.push(`${k} not set (needed for Phase 2)`);
  }

  return { ok, issues, notes };
}
