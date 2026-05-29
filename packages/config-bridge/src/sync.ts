/**
 * Sync (pull) canonical copies of AI-configs + an agent graph FROM a source LD
 * instance INTO a local directory.
 *
 * Writes to a caller-provided output dir — deliberately NOT the public
 * `config/agentcontrol/`, because pulled instructions may contain internal
 * references that need a sanitization pass before they can be committed to a
 * public repo (see ISSUES.md I3).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LdClient, LdResponse } from "@auto-factory/shared";

interface AiConfigListItem {
  key: string;
  tags?: string[];
}

interface AiConfigListPage {
  items?: AiConfigListItem[];
  _links?: { next?: { href?: string } };
}

/** List all AI configs in the source project (paginated). */
async function listAiConfigs(ld: LdClient): Promise<AiConfigListItem[]> {
  const items: AiConfigListItem[] = [];
  let path: string | null = `/api/v2/projects/${ld.projectKey}/ai-configs?limit=50`;
  while (path) {
    const res: LdResponse<AiConfigListPage> = await ld.request<AiConfigListPage>({
      path,
      headers: { "LD-API-Version": "beta" },
    });
    items.push(...(res.data.items ?? []));
    path = res.data._links?.next?.href ?? null;
  }
  return items;
}

export interface SyncOptions {
  /** Only pull configs carrying at least one of these tags (case-insensitive). */
  tags?: string[];
  /** Agent graph keys to pull. */
  graphKeys?: string[];
  /** Output directory; `ai-configs/` and `graphs/` subdirs are created under it. */
  outDir: string;
}

export interface SyncResult {
  aiConfigs: string[];
  graphs: string[];
}

export async function sync(ld: LdClient, opts: SyncOptions): Promise<SyncResult> {
  const aiDir = join(opts.outDir, "ai-configs");
  const graphDir = join(opts.outDir, "graphs");
  mkdirSync(aiDir, { recursive: true });
  if (opts.graphKeys?.length) mkdirSync(graphDir, { recursive: true });

  const wanted = opts.tags?.map((t) => t.toLowerCase());
  const result: SyncResult = { aiConfigs: [], graphs: [] };

  for (const item of await listAiConfigs(ld)) {
    if (wanted) {
      const tags = (item.tags ?? []).map((t) => t.toLowerCase());
      if (!tags.some((t) => wanted.includes(t))) continue;
    }
    const full = await ld.getAiConfig(item.key);
    writeFileSync(join(aiDir, `${item.key}.json`), JSON.stringify(full.data, null, 2) + "\n");
    result.aiConfigs.push(item.key);
  }

  for (const key of opts.graphKeys ?? []) {
    const g = await ld.getAgentGraph(key);
    if (g.status === 200) {
      writeFileSync(join(graphDir, `${key}.json`), JSON.stringify(g.data, null, 2) + "\n");
      result.graphs.push(key);
    }
  }
  return result;
}
