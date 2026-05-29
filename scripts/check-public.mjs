#!/usr/bin/env node
/**
 * check-public — guards the public repo against leaking proprietary material.
 *
 * Fails (exit 1) if either:
 *   1. any git-tracked file contains an internal infrastructure identifier, or
 *   2. anything under reference-private/ is tracked by git.
 *
 * The blocklist is intentionally HIGH-SIGNAL: the names of internal instances /
 * services that must never appear in a public repo. Public tool names (e.g.
 * Spinnaker) and our own prototype names (Vega, Beacon) are NOT blocked.
 *
 * Run: node scripts/check-public.mjs   (wired as `npm run check:public`)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Internal identifiers that must never appear in tracked files. */
const BLOCKLIST = [
  /catamorphic/i,
  /catfood/i,
  /\bgonfalon\b/i,
];

/** Files exempt from the content scan (this script defines the patterns; the
 *  seed instructions are the user's own pre-existing document). */
const EXEMPT = new Set([
  "scripts/check-public.mjs",
  "initial_instructions.md",
]);

/** Skip binary-ish / lock files by extension. */
const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|lock)$/i;

function tracked() {
  return execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
}

let failures = 0;

// 1. reference-private must not be tracked
const leakedPrivate = tracked().filter((f) => f.startsWith("reference-private/"));
if (leakedPrivate.length) {
  console.error("✗ reference-private/ files are tracked by git:");
  for (const f of leakedPrivate) console.error(`    ${f}`);
  failures += leakedPrivate.length;
}

// 2. content scan
for (const file of tracked()) {
  if (EXEMPT.has(file) || SKIP_EXT.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const pattern of BLOCKLIST) {
      if (pattern.test(line)) {
        console.error(`✗ ${file}:${i + 1}: internal identifier matches ${pattern}`);
        console.error(`    ${line.trim().slice(0, 120)}`);
        failures += 1;
      }
    }
  });
}

if (failures > 0) {
  console.error(`\ncheck-public FAILED with ${failures} issue(s). Do not commit/push.`);
  process.exit(1);
}
console.log("check-public passed ✓");
