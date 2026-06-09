#!/usr/bin/env node
/**
 * Notifier — a tiny post-deploy hook a service runs after deploying. POSTs the
 * deployed SHA range + service + environment to Beacon's /flag-releases.
 *
 * NON-BLOCKING by contract: it must never fail a deploy, so any error is logged
 * and the process still exits 0.
 *
 * Inputs (flags override env):
 *   --service <key>         (env SERVICE)            required
 *   --environment <key>     (env ENVIRONMENT)        default "production"
 *   --sha <sha>             (env RAILWAY_GIT_COMMIT_SHA / GIT_SHA)
 *   --previous-sha <sha>    (env PREVIOUS_SHA)       optional; see note below
 * Env: BEACON_URL, BEACON_WEBHOOK_SECRET (required)
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const beaconUrl = process.env.BEACON_URL;
  const secret = process.env.BEACON_WEBHOOK_SECRET;
  const service = arg("service") ?? process.env.SERVICE;
  const environment = arg("environment") ?? process.env.ENVIRONMENT ?? "production";
  const sha = arg("sha") ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA;
  // Beacon diffs `.release-flags/` between the current and previous SHA (new =
  // present now, absent before). Some CD systems (e.g. Railway) don't expose the
  // previously-deployed SHA natively, so this is optional — when absent Beacon
  // falls back to treating all release-flag files at the current SHA as new.
  const previousSha = arg("previous-sha") ?? process.env.PREVIOUS_SHA;

  if (!beaconUrl || !secret) throw new Error("BEACON_URL and BEACON_WEBHOOK_SECRET are required");
  if (!service || !sha) throw new Error("service and sha are required (--service, --sha)");

  const res = await fetch(`${beaconUrl.replace(/\/+$/, "")}/flag-releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-beacon-secret": secret },
    body: JSON.stringify({ sha, previousSha, service, environment }),
  });
  const text = await res.text();
  console.log(`notify → Beacon: HTTP ${res.status} ${text}`);
  if (!res.ok) throw new Error(`Beacon returned ${res.status}`);
}

main().catch((e) => {
  // Non-blocking: log and succeed so we never fail the deploy.
  console.warn(`notify warning (non-blocking): ${e instanceof Error ? e.message : e}`);
  process.exit(0);
});
