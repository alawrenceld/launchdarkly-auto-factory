/**
 * Provision agent AI-configs + agent graphs into a target LaunchDarkly project.
 *
 * Idempotent: GETs each resource first and only creates what's missing (backfills
 * variations). Ports the proven one-off behavior:
 *  - the first variation becomes the config's inline `defaultVariation`
 *  - `tools` / `toolKeys` are STRIPPED: our snapshots hold only references
 *    (`{key, version}` / `{{snippet.x}}`), not the tool/snippet definitions, so
 *    they can't be recreated verbatim — re-attach them in LD if needed
 *  - variations that fail (e.g. missing prompt snippet) are reported, not fatal
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LdApiError, LdClient } from "@auto-factory/shared";

/** Fields the variation POST accepts; copy whichever are present. */
const VAR_FIELDS = [
  "key", "name", "comment", "description", "instructions",
  "messages", "model", "modelConfigKey", "judgeConfiguration",
] as const;

export interface ProvisionResult {
  configsCreated: string[];
  configsExisting: string[];
  variationsCreated: number;
  variationsExisting: number;
  toolsStripped: Array<{ config: string; variation: string }>;
  failures: Array<{ resource: string; status: number; message: unknown }>;
  graphsCreated: string[];
  graphsExisting: string[];
  flagsCreated: string[];
  flagsExisting: string[];
}

interface AiVariation {
  key: string;
  tools?: unknown;
  toolKeys?: unknown;
  [k: string]: unknown;
}
interface AiConfigFile {
  key: string;
  name: string;
  description?: string;
  mode?: string;
  tags?: string[];
  variations?: AiVariation[];
}
interface AgentGraphFile {
  key: string;
  name: string;
  description?: string;
  rootConfigKey?: string;
  edges?: Array<{ key: string; sourceConfig: string; targetConfig: string; handoff?: unknown }>;
}
/** A flag-creation body (the operational flags the runtime reads, e.g. the
 *  provider selector and the approval gates). Provisioned off/default so the
 *  flag exists and is discoverable in the consumer's LD UI without changing
 *  behavior until they flip it. */
interface FlagFile {
  key: string;
  name: string;
  [k: string]: unknown;
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function mapVariation(
  v: AiVariation,
  configKey: string,
  result: ProvisionResult,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of VAR_FIELDS) if (v[f] !== undefined) out[f] = v[f];
  if (v.tools !== undefined || v.toolKeys !== undefined) {
    result.toolsStripped.push({ config: configKey, variation: v.key });
  }
  return out;
}

async function provisionAiConfig(
  ld: LdClient,
  cfg: AiConfigFile,
  result: ProvisionResult,
  dryRun: boolean,
): Promise<void> {
  const variations = cfg.variations ?? [];
  const existing = await ld.getAiConfig<{ variations?: { key: string }[] }>(cfg.key);

  let existingVarKeys = new Set<string>();
  if (existing.status === 200) {
    existingVarKeys = new Set((existing.data.variations ?? []).map((v) => v.key));
    result.configsExisting.push(cfg.key);
  } else {
    const body: Record<string, unknown> = {
      key: cfg.key,
      name: cfg.name,
      description: cfg.description ?? "",
      mode: cfg.mode ?? "agent",
      tags: cfg.tags ?? [],
    };
    if (variations[0]) body.defaultVariation = mapVariation(variations[0], cfg.key, result);
    try {
      if (!dryRun) await ld.createAiConfig(body);
      result.configsCreated.push(cfg.key);
      result.variationsCreated += variations[0] ? 1 : 0;
      if (variations[0]) existingVarKeys.add(variations[0].key);
    } catch (e) {
      const err = e as LdApiError;
      result.failures.push({ resource: `ai-config ${cfg.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
      return;
    }
  }

  for (const v of variations) {
    if (existingVarKeys.has(v.key)) {
      result.variationsExisting += 1;
      continue;
    }
    try {
      const mapped = mapVariation(v, cfg.key, result);
      if (!dryRun) await ld.createAiConfigVariation(cfg.key, mapped);
      result.variationsCreated += 1;
    } catch (e) {
      const err = e as LdApiError;
      result.failures.push({ resource: `${cfg.key}/${v.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
    }
  }
}

async function provisionGraph(
  ld: LdClient,
  g: AgentGraphFile,
  result: ProvisionResult,
  dryRun: boolean,
): Promise<void> {
  const existing = await ld.getAgentGraph(g.key);
  if (existing.status === 200) {
    result.graphsExisting.push(g.key);
    return;
  }
  const body = {
    key: g.key,
    name: g.name,
    description: g.description ?? "",
    ...(g.rootConfigKey ? { rootConfigKey: g.rootConfigKey } : {}),
    edges: (g.edges ?? []).map((e) => ({
      key: e.key,
      sourceConfig: e.sourceConfig,
      targetConfig: e.targetConfig,
      handoff: e.handoff ?? {},
    })),
  };
  try {
    if (!dryRun) await ld.createAgentGraph(body);
    result.graphsCreated.push(g.key);
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `graph ${g.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

/** Create an operational flag if absent (idempotent; existing flag left untouched). */
async function provisionFlag(ld: LdClient, flag: FlagFile, result: ProvisionResult, dryRun: boolean): Promise<void> {
  // 404-tolerant existence check, so an already-configured flag (and its
  // targeting) is never overwritten.
  const existing = await ld.request({ path: `/api/v2/flags/${ld.projectKey}/${flag.key}`, okStatuses: [404] });
  if (existing.status === 200) {
    result.flagsExisting.push(flag.key);
    return;
  }
  try {
    if (!dryRun) await ld.createFlag(flag);
    result.flagsCreated.push(flag.key);
  } catch (e) {
    const err = e as LdApiError;
    result.failures.push({ resource: `flag ${flag.key}`, status: err.status ?? 0, message: err.responseBody ?? String(e) });
  }
}

export interface ProvisionOptions {
  /** Directory of AI-config JSON files. */
  aiConfigsDir: string;
  /** Directory of agent-graph JSON files. */
  graphsDir: string;
  /**
   * Directory of operational-flag JSON files. Default
   * `config/agentcontrol/flags`. These are repo-owned operational defaults (NOT
   * pulled from a source project), so the seed path provisions them too.
   */
  flagsDir?: string;
  /** When true, perform reads only — report what would be created without writing. */
  dryRun?: boolean;
}

export async function provision(ld: LdClient, opts: ProvisionOptions): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    configsCreated: [], configsExisting: [], variationsCreated: 0, variationsExisting: 0,
    toolsStripped: [], failures: [], graphsCreated: [], graphsExisting: [], flagsCreated: [], flagsExisting: [],
  };
  const dryRun = opts.dryRun ?? false;

  for (const file of listJson(opts.aiConfigsDir)) {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as AiConfigFile;
    await provisionAiConfig(ld, cfg, result, dryRun);
  }
  // Graphs after configs — they reference config keys.
  for (const file of listJson(opts.graphsDir)) {
    const g = JSON.parse(readFileSync(file, "utf8")) as AgentGraphFile;
    await provisionGraph(ld, g, result, dryRun);
  }
  // Operational flags (provider selector, approval gates). Always from the
  // repo's committed defs, so this runs for both `provision` and `seed`.
  for (const file of listJson(opts.flagsDir ?? "config/agentcontrol/flags")) {
    const flag = JSON.parse(readFileSync(file, "utf8")) as FlagFile;
    await provisionFlag(ld, flag, result, dryRun);
  }
  return result;
}
