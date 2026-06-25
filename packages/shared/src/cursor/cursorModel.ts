/**
 * Maps the LaunchDarkly AI config's model + parameters onto a Cursor model
 * selection. This is what lets "which model and with what parameters" be DERIVED
 * FROM LAUNCHDARKLY for the Cursor provider, exactly as it is for the Anthropic
 * provider — instead of hardcoding a Cursor model in the runner.
 *
 * The catch the SDK forces (see ADR 0006): Cursor's catalog uses its own model
 * id strings, and its model parameters are model-specific ids (e.g. "fast"),
 * NOT the generic `temperature` / `maxTokens` an LD AI config typically stores.
 * So:
 *   - the model NAME is matched against the live catalog (exact, then fuzzy);
 *   - model PARAMETERS are mapped only where an LD param id lines up with a
 *     parameter the chosen Cursor model actually accepts — the rest are reported
 *     as dropped, so the divergence is visible rather than silent.
 * All inference runs on Cursor's hosted models regardless of the matched id;
 * we don't (and can't) route to LaunchDarkly's Bedrock instance here.
 */

import type { ModelListItem, ModelParameterValue } from "@cursor/sdk";

/**
 * Normalize a model name for cross-namespace comparison: lowercase, strip a
 * leading region segment ("us.") and provider prefixes ("anthropic." /
 * "bedrock."), drop a trailing Bedrock version suffix ("-v1:0"), and collapse
 * any remaining punctuation to single hyphens. So
 * "us.anthropic.claude-sonnet-4-6-v1:0" and "claude-sonnet-4-6" both become
 * "claude-sonnet-4-6".
 */
export function normalizeModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^[a-z]{2}\./, "") // region, e.g. "us."
    .replace(/^(anthropic|bedrock|openai|google)\./, "") // provider prefix
    .replace(/[-_]v\d+(:\d+)?$/, "") // bedrock version suffix, e.g. "-v1:0"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface CursorModelMatch {
  /** The Cursor model id to pass to `Agent.create`. */
  id: string;
  /** True when it came from the LD model name; false when it's the fallback. */
  matched: boolean;
  /** Human-readable explanation, for the per-node log. */
  reason: string;
}

/**
 * Resolve the LD-configured model name to a Cursor model id from the live
 * catalog. Tries an exact id/alias match first, then a fuzzy substring match in
 * either direction (so "claude-sonnet-4-6" matches a catalog "claude-4.6-sonnet"
 * display/alias). Falls back to `fallback` (the operator's `CURSOR_MODEL`) when
 * nothing matches or no name was configured.
 */
export function mapToCursorModel(
  ldModelName: string | undefined,
  catalog: ModelListItem[],
  fallback: string,
): CursorModelMatch {
  if (!ldModelName) {
    return { id: fallback, matched: false, reason: `no LD model configured → fallback '${fallback}'` };
  }
  const want = normalizeModelName(ldModelName);

  for (const m of catalog) {
    const ids = [m.id, ...(m.aliases ?? [])].map(normalizeModelName);
    if (ids.includes(want)) return { id: m.id, matched: true, reason: `exact match on '${m.id}'` };
  }
  for (const m of catalog) {
    const candidates = [m.id, ...(m.aliases ?? []), m.displayName ?? ""].map(normalizeModelName).filter(Boolean);
    if (candidates.some((c) => c.includes(want) || want.includes(c))) {
      return { id: m.id, matched: true, reason: `fuzzy match '${ldModelName}' → '${m.id}'` };
    }
  }
  return {
    id: fallback,
    matched: false,
    reason: `no Cursor catalog match for '${ldModelName}' (normalized '${want}') → fallback '${fallback}'`,
  };
}

export interface MappedModelParameters {
  /** Parameters to pass on the Cursor `ModelSelection`. */
  params: ModelParameterValue[];
  /** LD param keys that have no equivalent on the chosen Cursor model (reported, not applied). */
  dropped: string[];
}

/**
 * Map the LD AI config's `model.parameters` onto the chosen Cursor model's
 * accepted parameters. Only keys whose id matches a parameter the model defines
 * (and whose value is allowed, when the model enumerates allowed values) are
 * applied; everything else is returned in `dropped`. In practice LD's generic
 * `temperature` / `maxTokens` usually have no Cursor equivalent and land in
 * `dropped` — that's expected and surfaced, not hidden.
 */
export function mapModelParameters(
  ldParams: Record<string, unknown> | undefined,
  modelDef: ModelListItem | undefined,
): MappedModelParameters {
  if (!ldParams || Object.keys(ldParams).length === 0) return { params: [], dropped: [] };
  const defs = modelDef?.parameters ?? [];
  const byId = new Map(defs.map((d) => [d.id.toLowerCase(), d]));
  const params: ModelParameterValue[] = [];
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(ldParams)) {
    const def = byId.get(k.toLowerCase());
    if (!def) {
      dropped.push(k);
      continue;
    }
    const value = String(v);
    if (def.values?.length && !def.values.some((x) => x.value === value)) {
      dropped.push(`${k}=${value} (not an allowed value for '${def.id}')`);
      continue;
    }
    params.push({ id: def.id, value });
  }
  return { params, dropped };
}
