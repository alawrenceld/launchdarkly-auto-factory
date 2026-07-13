#!/usr/bin/env node
/**
 * Regenerate config/agentcontrol/tools/*.json from the code registry
 * (SANDBOX_TOOL_DEFS in packages/shared) — one file per sandbox tool, in the
 * shape the LaunchDarkly ai-tools API consumes. Run after adding or renaming
 * a tool in code: `npm run build && node scripts/export-tools.mjs`.
 *
 * The committed files are the canonical DEFAULTS the bridge provisions into
 * LaunchDarkly; after provisioning, descriptions/schemas are editable in the
 * LD UI (Library → Tools) and take effect on the next run. Code keeps the
 * same defaults as fallback for variations with no attachments.
 */

import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const { SANDBOX_TOOL_DEFS } = await import("../packages/shared/dist/index.js");

const outDir = "config/agentcontrol/tools";
mkdirSync(outDir, { recursive: true });

const written = [];
for (const [name, def] of SANDBOX_TOOL_DEFS) {
  const file = join(outDir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        key: name,
        name,
        description: def.description,
        schema: def.input_schema,
      },
      null,
      2,
    ) + "\n",
  );
  written.push(name);
}

// Flag stale files for tools that no longer exist in code.
const stale = readdirSync(outDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .filter((n) => !written.includes(n));

console.log(`export-tools: wrote ${written.length} tool definition(s) to ${outDir}`);
if (stale.length) console.warn(`export-tools: STALE files (no matching code tool — delete or re-add): ${stale.join(", ")}`);
