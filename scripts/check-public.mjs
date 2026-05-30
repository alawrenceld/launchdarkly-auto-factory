#!/usr/bin/env node
/**
 * check-public — guards the public repo against leaking proprietary material.
 *
 * Fails (exit 1) if either:
 *   1. any git-tracked file contains an internal infrastructure identifier, or
 *   2. anything under reference-private/ is tracked by git.
 *
 * The blocklist is stored as **SHA-256 hashes**, not plaintext — so this public
 * script never spells out the internal instance/service names it guards against.
 * The scan hashes each word (length >= 5) of each tracked text file and checks
 * membership. Public tool names and our own prototype names are not blocked.
 *
 * Run: node scripts/check-public.mjs   (wired as `npm run check:public`)
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** SHA-256 of the lowercased internal identifiers that must never appear. */
const BLOCKED_HASHES = new Set([
  "d47b38032d2b91dc3928589737b39b94d205b565dcffd115be4f4a07ee67f975",
  "708730ab8dc65c819f68bf5f31798dee15aa3147b2d3048ca96f944e0b78b9a4",
  "89a2d9290d40484effccb61cb02732f2fb87991aa29361dcdc1f43c3fbcc9067",
]);

const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|lock)$/i;

function tracked() {
  return execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
}

function hash(s) {
  return createHash("sha256").update(s.toLowerCase()).digest("hex");
}

let failures = 0;

// 1. reference-private must not be tracked
const leakedPrivate = tracked().filter((f) => f.startsWith("reference-private/"));
if (leakedPrivate.length) {
  console.error("✗ reference-private/ files are tracked by git:");
  for (const f of leakedPrivate) console.error(`    ${f}`);
  failures += leakedPrivate.length;
}

// 2. content scan (hashed)
for (const file of tracked()) {
  if (SKIP_EXT.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const word of line.split(/[^A-Za-z0-9]+/)) {
      if (word.length < 5) continue;
      if (BLOCKED_HASHES.has(hash(word))) {
        console.error(`✗ ${file}:${i + 1}: blocked internal identifier (${word.slice(0, 2)}***)`);
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
