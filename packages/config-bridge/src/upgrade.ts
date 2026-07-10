/**
 * Upgrade a target LaunchDarkly project to the repo's committed definitions —
 * the "existing installer" path. `provision` is create-only, so installs made
 * before a repo change can never receive it; `upgrade` closes that gap:
 *
 *  1. Runs `provision` first — creates any missing configs, variations, graphs,
 *     and operational flags with the proven semantics (inline defaultVariation,
 *     judgeConfiguration re-attach, tool stripping).
 *  2. Update pass over what already exists:
 *     - AI-config variations: PATCH `instructions` / `messages` when they differ
 *       from the committed copy, and attach `judgeConfiguration` when the
 *       committed def has one and live doesn't. Every content PATCH is followed
 *       by a no-op `modelConfigKey` re-PATCH — the cost-derivation workaround
 *       (non-model variation PATCHes silently sever cost tracking otherwise).
 *     - Agent graphs: full-object PATCH when the committed root/edge set differs
 *       (the graph API is not JSON Patch).
 *
 * NEVER touched: flag variations/targeting (runtime state — drift is REPORTED,
 * not fixed), model choices (a live modelConfigKey that differs from committed
 * may be a deliberate switch or an A/B arm — reported only), extra live
 * variations the repo doesn't know about (e.g. a Composer A/B variation), and
 * judge sampling rates. `dryRun` reports the full plan without writing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeConfigHash, stampDescription, type LdApiError, type LdClient } from "@auto-factory/shared";
import { provision, type ProvisionResult } from "./provision.js";

interface CommittedVariation {
  key: string;
  instructions?: string;
  messages?: Array<{ role: string; content: string }>;
  modelConfigKey?: string;
  judgeConfiguration?: unknown;
  [k: string]: unknown;
}
interface CommittedConfig {
  key: string;
  variations?: CommittedVariation[];
}
type LiveVariation = CommittedVariation;
interface GraphFile {
  key: string;
  name: string;
  description?: string;
  rootConfigKey?: string;
  edges?: Array<{ key: string; sourceConfig: string; targetConfig: string; handoff?: unknown }>;
}

export interface UpgradeResult {
  provision: ProvisionResult;
  variationsUpdated: string[];
  graphsUpdated: string[];
  drift: string[];
  failures: Array<{ resource: string; message: unknown }>;
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** The graph fields we own; live GETs carry extra metadata (_links, ids) that
 *  must not count as drift. */
function ownedGraphShape(g: { rootConfigKey?: string; edges?: unknown[] }): string {
  const edges = ((g.edges ?? []) as GraphFile["edges"])!
    .map((e) => ({ key: e.key, sourceConfig: e.sourceConfig, targetConfig: e.targetConfig, handoff: e.handoff ?? {} }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const stable = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, stable(val)]))
      : Array.isArray(v) ? v.map(stable) : v;
  return JSON.stringify({ rootConfigKey: g.rootConfigKey, edges: edges.map(stable) });
}

export interface UpgradeOptions {
  aiConfigsDir: string;
  graphsDir: string;
  flagsDir?: string;
  dryRun?: boolean;
}

export async function upgrade(ld: LdClient, opts: UpgradeOptions): Promise<UpgradeResult> {
  const dryRun = opts.dryRun ?? false;

  // Phase 1: create everything that's missing (idempotent, existing untouched).
  const created = await provision(ld, opts);

  const result: UpgradeResult = {
    provision: created, variationsUpdated: [], graphsUpdated: [], drift: [], failures: [],
  };

  // Phase 2a: sync existing variation CONTENT to the committed copy.
  for (const file of listJson(opts.aiConfigsDir)) {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as CommittedConfig;
    try {
      const live = await ld.getAiConfig<{ variations?: LiveVariation[] }>(cfg.key);
      if (live.status !== 200) continue; // creation failed in phase 1; already reported there
      const liveVars = new Map((live.data.variations ?? []).map((v) => [v.key, v]));
      for (const v of cfg.variations ?? []) {
        const lv = liveVars.get(v.key);
        if (!lv) continue; // just created (or create failed) — content already committed-shaped
        const patch: Record<string, unknown> = {};
        if (v.instructions !== undefined && v.instructions !== lv.instructions) patch.instructions = v.instructions;
        if (v.messages !== undefined && JSON.stringify(v.messages) !== JSON.stringify(lv.messages)) patch.messages = v.messages;
        if (v.judgeConfiguration !== undefined && lv.judgeConfiguration === undefined) patch.judgeConfiguration = v.judgeConfiguration;
        if (v.modelConfigKey && lv.modelConfigKey && v.modelConfigKey !== lv.modelConfigKey) {
          result.drift.push(`${cfg.key}/${v.key}: model differs (committed ${v.modelConfigKey}, live ${lv.modelConfigKey}) — left as-is (may be a deliberate switch or A/B arm)`);
        }
        if (Object.keys(patch).length === 0) continue;
        if (!dryRun) {
          await ld.updateAiConfigVariation(cfg.key, v.key, {
            ...patch,
            comment: "bridge upgrade: sync to committed definition",
          });
          // Cost-derivation workaround: any non-model variation PATCH severs
          // cost tracking; a no-op modelConfigKey re-PATCH restores it.
          if (lv.modelConfigKey) {
            await ld.updateAiConfigVariation(cfg.key, v.key, {
              modelConfigKey: lv.modelConfigKey,
              comment: "bridge upgrade: no-op modelConfigKey re-patch (cost workaround)",
            });
          }
        }
        result.variationsUpdated.push(`${cfg.key}/${v.key} (${Object.keys(patch).join(", ")})`);
      }
    } catch (e) {
      result.failures.push({ resource: `ai-config ${cfg.key}`, message: (e as LdApiError).responseBody ?? String(e) });
    }
  }

  // Phase 2b: full-object PATCH graphs whose owned shape drifted — or whose
  // [cfg:…] stamp is stale. The stamp certifies "provisioned at repo version X",
  // so it must refresh on EVERY upgrade that syncs content, even when the graph
  // shape itself is unchanged (e.g. instruction-only updates).
  const configHash = computeConfigHash({
    aiConfigsDir: opts.aiConfigsDir,
    graphsDir: opts.graphsDir,
    flagsDir: opts.flagsDir ?? "config/agentcontrol/flags",
  });
  for (const file of listJson(opts.graphsDir)) {
    const g = JSON.parse(readFileSync(file, "utf8")) as GraphFile;
    try {
      const live = await ld.getAgentGraph<{ rootConfigKey?: string; edges?: unknown[]; description?: string }>(g.key);
      if (live.status !== 200) continue; // created (or failed) in phase 1
      const targetDesc = configHash ? stampDescription(g.description, configHash) : (g.description ?? "");
      if (ownedGraphShape(g) === ownedGraphShape(live.data) && (live.data.description ?? "") === targetDesc) continue;
      if (!dryRun) {
        await ld.updateAgentGraph(g.key, {
          key: g.key,
          name: g.name,
          description: targetDesc,
          ...(g.rootConfigKey ? { rootConfigKey: g.rootConfigKey } : {}),
          edges: (g.edges ?? []).map((e) => ({ key: e.key, sourceConfig: e.sourceConfig, targetConfig: e.targetConfig, handoff: e.handoff ?? {} })),
        });
      }
      result.graphsUpdated.push(g.key);
    } catch (e) {
      result.failures.push({ resource: `graph ${g.key}`, message: (e as LdApiError).responseBody ?? String(e) });
    }
  }

  // Phase 2c: report (never fix) operational-flag drift — variations/targeting
  // are the operator's runtime state.
  for (const file of listJson(opts.flagsDir ?? "config/agentcontrol/flags")) {
    const flag = JSON.parse(readFileSync(file, "utf8")) as { key: string; variations?: Array<{ value: unknown }> };
    try {
      const live = await ld.request<{ variations?: Array<{ value: unknown }> }>({
        path: `/api/v2/flags/${ld.projectKey}/${flag.key}`,
        okStatuses: [404],
      });
      if (live.status !== 200) continue;
      const committedVals = JSON.stringify((flag.variations ?? []).map((v) => v.value));
      const liveVals = JSON.stringify((live.data.variations ?? []).map((v) => v.value));
      if (committedVals !== liveVals) {
        result.drift.push(`flag ${flag.key}: variation values differ (committed ${committedVals}, live ${liveVals}) — left as-is (runtime state; reconcile in the LD UI if wanted)`);
      }
    } catch (e) {
      result.failures.push({ resource: `flag ${flag.key}`, message: (e as LdApiError).responseBody ?? String(e) });
    }
  }

  return result;
}
