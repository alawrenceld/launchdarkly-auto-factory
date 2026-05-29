#!/usr/bin/env node
/**
 * One-command bootstrap (`npm run bootstrap`):
 *   1. build the workspace if needed
 *   2. preflight checks (Node, LD env, LD reachability) — fail loudly
 *   3. provision agent configs + graph into the target project (via the bridge)
 *   4. print the remaining manual steps (drop in the workflow, set secrets)
 *
 * Defaults are one layer deep: this generates/uses the real config files in
 * config/ that a partner then edits — no hidden magic.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

console.log("LaunchDarkly Auto-Factory — bootstrap\n");

// 1. Ensure build output exists before importing built packages.
if (!existsSync("packages/config-bridge/dist/cli.js") || !existsSync("packages/shared/dist/index.js")) {
  console.log("Building workspace…");
  execSync("npm run build", { stdio: "inherit" });
}

// 2. Preflight (dynamic import — depends on the build above).
const { preflight } = await import("./checks/preflight.mjs");
console.log("Preflight checks:");
const { ok, issues, notes } = await preflight();
ok.forEach((m) => console.log("  ✓", m));
notes.forEach((m) => console.log("  •", m));
if (issues.length) {
  issues.forEach((m) => console.error("  ✗", m));
  console.error("\nResolve the above (see .env.example), then re-run `npm run bootstrap`.");
  process.exit(1);
}

// 3. Provision agent configs + graph into the target project.
console.log("\nProvisioning agent configs + graph into the target project…");
execSync("node packages/config-bridge/dist/cli.js provision", { stdio: "inherit" });

// 4. Remaining manual steps.
console.log(`
Next steps:
  1. Copy bootstrap/github-action-template/auto-factory.yml → .github/workflows/ in your app repo
     (set <owner> to the repo hosting this action).
  2. Add repo secrets: LD_API_KEY  (+ GITHUB_TOKEN and BEACON_WEBHOOK_SECRET for Phase 2).
  3. Open a PR — Phase 1 runs automatically.

Note: canonical agent configs live in config/agentcontrol/ (populated after the
sanitization review — see docs/ISSUES.md I3). Until then, provision is a no-op.
`);
