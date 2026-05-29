#!/usr/bin/env node
/**
 * Config bridge CLI.
 *
 *   bridge provision [--ai-configs <dir>] [--graphs <dir>]
 *       Provision AI-configs + graphs into the TARGET LD project (LD_* env).
 *       Defaults: config/agentcontrol/ai-configs, config/agentcontrol/graphs
 *
 *   bridge sync --out <dir> [--tags a,b] [--graphs key1,key2]
 *       Pull AI-configs (optionally tag-filtered) + named graphs FROM the SOURCE
 *       LD project (LD_SOURCE_* env) into <dir>. Output needs a sanitization
 *       review before committing to the public repo (see docs/ISSUES.md I3).
 */

import { LdClient, sourceConnection, targetConnection } from "@auto-factory/shared";
import { provision } from "./provision.js";
import { sync } from "./sync.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "provision") {
    const ld = new LdClient(targetConnection());
    const aiConfigsDir = flag(args, "ai-configs") ?? "config/agentcontrol/ai-configs";
    const graphsDir = flag(args, "graphs") ?? "config/agentcontrol/graphs";
    console.log(`Provisioning into project '${ld.projectKey}'`);
    console.log(`  ai-configs: ${aiConfigsDir}\n  graphs:     ${graphsDir}\n`);
    const r = await provision(ld, { aiConfigsDir, graphsDir });
    console.log(`Configs:    ${r.configsCreated.length} created, ${r.configsExisting.length} existing`);
    console.log(`Variations: ${r.variationsCreated} created, ${r.variationsExisting} existing`);
    console.log(`Graphs:     ${r.graphsCreated.length} created, ${r.graphsExisting.length} existing`);
    if (r.toolsStripped.length) {
      console.log(`⚠ tools stripped from ${r.toolsStripped.length} variation(s) — re-attach in LD (ISSUES I4)`);
    }
    if (r.failures.length) {
      console.log(`✗ ${r.failures.length} failure(s):`);
      for (const f of r.failures) console.log(`    ${f.resource} [${f.status}]: ${JSON.stringify(f.message)}`);
      process.exitCode = 1;
    } else {
      console.log("Done.");
    }
    return;
  }

  if (cmd === "sync") {
    const conn = sourceConnection();
    if (!conn) throw new Error("Source not configured — set LD_SOURCE_API_KEY / LD_SOURCE_BASE_URL / LD_SOURCE_PROJECT_KEY");
    const out = flag(args, "out");
    if (!out) throw new Error("sync requires --out <dir>");
    const tags = flag(args, "tags")?.split(",").map((t) => t.trim()).filter(Boolean);
    const graphKeys = flag(args, "graphs")?.split(",").map((t) => t.trim()).filter(Boolean);
    const ld = new LdClient(conn);
    console.log(`Syncing from project '${ld.projectKey}' → ${out}`);
    const r = await sync(ld, { outDir: out, tags, graphKeys });
    console.log(`Pulled ${r.aiConfigs.length} ai-config(s), ${r.graphs.length} graph(s).`);
    console.log("⚠ Review/sanitize before committing to the public repo (ISSUES I3).");
    return;
  }

  console.error("Usage: bridge <provision|sync> [options]");
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
