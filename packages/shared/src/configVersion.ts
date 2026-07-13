/**
 * Config version stamping — drift detection between the repo's committed
 * agent definitions and what a LaunchDarkly project was last provisioned with.
 *
 * `provision`/`upgrade` compute a content hash of the committed config files
 * and stamp it into the agent graph's description as `[cfg:<hash12>]` (the one
 * writable metadata surface on a graph). At chain start the GHA action — which
 * runs from a checkout of this repo — computes the same hash from its own
 * files and compares against the stamp: a mismatch means the runtime code and
 * the provisioned configs come from different repo versions, the mixed state
 * where new tools exist but no agent instructions mention them.
 *
 * The stamp deliberately does NOT track live instruction content: editing
 * agent instructions in the LD UI is a supported workflow, not drift.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STAMP_RE = /\s*\[cfg:([0-9a-f]{12})\]/;

export interface ConfigDirs {
  aiConfigsDir: string;
  graphsDir: string;
  flagsDir: string;
  /** Tools-library definitions (ADR 0011); optional for pre-tools callers. */
  toolsDir?: string;
}

/**
 * Content hash (12 hex chars) of the committed config files. Labels entries by
 * canonical subdir name, not the actual path, so the hash is identical whether
 * computed from the repo, an action checkout, or a copy. Returns undefined
 * when no config files are found (e.g. running outside a repo checkout).
 */
export function computeConfigHash(dirs: ConfigDirs): string | undefined {
  const sources: Array<[label: string, dir: string]> = [
    ["ai-configs", dirs.aiConfigsDir],
    ["graphs", dirs.graphsDir],
    ["flags", dirs.flagsDir],
    ...(dirs.toolsDir ? ([["tools", dirs.toolsDir]] as Array<[string, string]>) : []),
  ];
  const h = createHash("sha256");
  let files = 0;
  for (const [label, dir] of sources) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      h.update(`${label}/${name}\n`);
      h.update(readFileSync(join(dir, name)));
      h.update("\n");
      files += 1;
    }
  }
  return files ? h.digest("hex").slice(0, 12) : undefined;
}

/** Append (or replace) the `[cfg:…]` marker on a graph description. */
export function stampDescription(description: string | undefined, hash: string): string {
  const base = (description ?? "").replace(STAMP_RE, "").trimEnd();
  return base ? `${base} [cfg:${hash}]` : `[cfg:${hash}]`;
}

/** Extract the stamped hash from a graph description, if present. */
export function extractConfigStamp(description: string | undefined): string | undefined {
  return description?.match(STAMP_RE)?.[1];
}
