/**
 * LaunchDarkly resource writer for the agent write tools.
 *
 * Programmatic flag + metric creation are REST operations (no SDK creates them),
 * so this wraps the `api-`-key `LdClient` pointed at the APP/data-plane project.
 * Kept tiny and idempotent: LaunchDarkly returns 409 when the resource already
 * exists (PR re-runs on synchronize), which we report rather than treat as an
 * error.
 */

import type { LdClient } from "../ldClient.js";

export interface CreateFlagArgs {
  /** Flag key (e.g. "enable-farewell"). */
  key: string;
  /** Human-readable name. Defaults to the key. */
  name?: string;
  description?: string;
  /** Extra tags, merged with the standard auto-factory tags. */
  tags?: string[];
}

/**
 * Guarded-release metric categories. Each maps to a LaunchDarkly metric shape:
 *  - error    → occurrence (isNumeric=false), LowerThanBaseline
 *  - latency  → numeric (isNumeric=true, unit, average aggregation), LowerThanBaseline
 *  - business → occurrence (isNumeric=false), HigherThanBaseline
 */
export type MetricCategory = "error" | "latency" | "business";

export interface CreateMetricArgs {
  /** Metric key, e.g. "enable-fact-endpoint-error-rate". */
  key: string;
  /** Custom event name the app emits via `track()` — what the metric measures. */
  eventKey: string;
  category: MetricCategory;
  /** Human-readable name. Defaults to the key. */
  name?: string;
  description?: string;
  /** Randomization unit; MUST match the flag rollout's unit. Default "user". */
  randomizationUnit?: string;
  /** Numeric unit (latency only). Default "ms". */
  unit?: string;
  /** Extra tags, merged with the standard auto-factory tags. */
  tags?: string[];
}

export interface LdWriteResult {
  created: boolean;
  alreadyExists: boolean;
  key: string;
  detail: string;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export class LdResourceWriter {
  constructor(private readonly ld: LdClient) {}

  get projectKey(): string {
    return this.ld.projectKey;
  }

  /**
   * Create a boolean feature flag (treatment=true / control=false) following the
   * AutoFactory convention: temporary, off-variation = control (safe default).
   */
  async createBooleanFlag(args: CreateFlagArgs): Promise<LdWriteResult> {
    if (!args.key) throw new Error("flag key is required");
    const body = {
      key: args.key,
      name: args.name || args.key,
      ...(args.description ? { description: args.description } : {}),
      temporary: true,
      tags: dedupe(["auto-factory", "auto-generated", ...(args.tags ?? [])]),
      variations: [
        { value: true, name: "Treatment" },
        { value: false, name: "Control" },
      ],
      // On = treatment (index 0); Off = control (index 1) — flag-off preserves existing behavior.
      defaults: { onVariation: 0, offVariation: 1 },
    };
    const res = await this.ld.createFlag(body);
    const alreadyExists = res.status === 409;
    return {
      created: !alreadyExists,
      alreadyExists,
      key: args.key,
      detail: alreadyExists
        ? `Flag '${args.key}' already exists in project '${this.ld.projectKey}' (no change).`
        : `Created flag '${args.key}' in project '${this.ld.projectKey}'.`,
    };
  }

  /**
   * Create a guarded-release metric off a custom event. Maps the friendly
   * category to LaunchDarkly's metric fields (kind=custom, isNumeric/unit,
   * successCriteria). Idempotent: a 409 (key already exists) is reported, not thrown.
   */
  async createMetric(args: CreateMetricArgs): Promise<LdWriteResult> {
    if (!args.key) throw new Error("metric key is required");
    if (!args.eventKey) throw new Error("metric eventKey is required");
    const numeric = args.category === "latency";
    const successCriteria = args.category === "business" ? "HigherThanBaseline" : "LowerThanBaseline";
    const unit = args.randomizationUnit || "user";
    const body: Record<string, unknown> = {
      key: args.key,
      name: args.name || args.key,
      ...(args.description ? { description: args.description } : {}),
      kind: "custom",
      eventKey: args.eventKey,
      isNumeric: numeric,
      successCriteria,
      randomizationUnits: [unit],
      tags: dedupe(["auto-factory", "auto-generated", ...(args.tags ?? [])]),
      // Numeric (latency) metrics need a unit + an aggregation; occurrence metrics don't.
      ...(numeric ? { unit: args.unit || "ms", unitAggregationType: "average" } : {}),
    };
    const res = await this.ld.createMetric(body);
    const alreadyExists = res.status === 409;
    return {
      created: !alreadyExists,
      alreadyExists,
      key: args.key,
      detail: alreadyExists
        ? `Metric '${args.key}' already exists in project '${this.ld.projectKey}' (no change).`
        : `Created ${args.category} metric '${args.key}' (event '${args.eventKey}') in project '${this.ld.projectKey}'.`,
    };
  }
}
