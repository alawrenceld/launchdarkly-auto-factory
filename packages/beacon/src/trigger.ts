/**
 * Release trigger. Resolves the flag's variations, picks the release method
 * (override → sensible default), and executes via the shared release adapter.
 *
 * Scope note (prototype): handles BOOLEAN flags (off=false → on=true). Precedence
 * for the rollout shape is overrides > the flag's configured release policy
 * (read via getReleasePolicy) > the demo defaults below.
 */

import {
  getReleasePolicy,
  normalizeReleaseIntent,
  startRelease,
  type DiscoveredFlag,
  type LdClient,
  type MetricRef,
  type ReleaseKind,
  type ReleasePolicy,
  type Stage,
} from "@auto-factory/shared";

/** Demo default rollouts when neither overrides nor a configured policy provide stages. */
const DEFAULT_PROGRESSIVE_STAGES: Stage[] = [
  { allocation: 20000, durationMillis: 300000 },
  { allocation: 50000, durationMillis: 300000 },
  { allocation: 100000, durationMillis: 300000 },
];
// Guarded stages are capped at 50% by LaunchDarkly (the metric comparison
// needs a control group at least as large as the treatment); the release
// completes to 100% after the final monitored stage passes. Confirmed live:
// a 100% stage is rejected with "stage allocation must not exceed 50%".
const DEFAULT_GUARDED_STAGES: Stage[] = [
  { allocation: 20000, durationMillis: 300000 },
  { allocation: 50000, durationMillis: 300000 },
];
const DEFAULT_RANDOMIZATION_UNIT = "user";

interface FlagVariations {
  variations?: Array<{ _id: string; value: unknown }>;
  /** Present when the flag is fetched with `?env=<key>`. */
  environments?: Record<string, { on?: boolean }>;
}

export interface TriggerResult {
  flagKey: string;
  /**
   * The release method used, or an intent outcome: "held" (releaseIntent said
   * hold/manual, a future notBefore, a not-yet-executable ask like segments, or
   * an unintelligible intent — fail-closed) / "prerequisites" (flag turned on
   * behind LD prerequisites; it releases when its parents do).
   */
  method: ReleaseKind | "held" | "prerequisites";
  note?: string;
}

export async function triggerRelease(
  ld: LdClient,
  flag: DiscoveredFlag,
  environmentKey: string,
): Promise<TriggerResult> {
  // HUMAN release intent (manifest releaseIntent, schema 1.1) is checked FIRST —
  // it directs everything below. Deterministic normalization only at deploy
  // time; anything unintelligible or not yet executable fails closed to "held".
  const { intent, issues } = normalizeReleaseIntent(flag.releaseIntent);
  const intentContext = [
    intent.reference ? `ref: ${intent.reference}` : "",
    intent.approvedBy ? `approved by: ${intent.approvedBy}` : "",
    intent.notes ? `notes: ${intent.notes.slice(0, 200)}` : "",
    issues.length ? `intent issues: ${issues.join("; ")}` : "",
  ].filter(Boolean).join(" | ");

  if (intent.action === "hold" || intent.action === "manual") {
    return {
      flagKey: flag.flagKey,
      method: "held",
      note: `releaseIntent action=${intent.action} — not auto-released${intentContext ? ` (${intentContext})` : ""}`,
    };
  }
  if (intent.notBefore && new Date(intent.notBefore).getTime() > Date.now()) {
    return {
      flagKey: flag.flagKey,
      method: "held",
      note: `releaseIntent notBefore=${intent.notBefore} is in the future — not auto-released${intentContext ? ` (${intentContext})` : ""}`,
    };
  }
  if (intent.segments && intent.segments.length > 0) {
    // Segment-first serving is recorded but not yet executed (LD-native
    // multi-phase releases will own this) — fail closed rather than guess.
    return {
      flagKey: flag.flagKey,
      method: "held",
      note: `releaseIntent asks for segment serving [${intent.segments.join(", ")}] — not yet auto-executable${intentContext ? ` (${intentContext})` : ""}`,
    };
  }

  const { data } = await ld.getFlag<FlagVariations>(flag.flagKey, `?env=${encodeURIComponent(environmentKey)}`);
  const variations = data.variations ?? [];
  const onVar = variations.find((v) => v.value === true);
  const offVar = variations.find((v) => v.value === false);
  if (!onVar || !offVar) {
    throw new Error(
      `Prototype supports boolean flags only; '${flag.flagKey}' has no true/false variations`,
    );
  }
  // Auto-factory flags are created DARK (targeting off) — merge ≠ release. LD
  // refuses to start an automated release on an off flag ("flag … is off",
  // confirmed live), so the same semantic patch turns targeting on; the release
  // instruction owns the fallthrough, so no traffic shifts except via stages.
  const flagIsOn = data.environments?.[environmentKey]?.on === true;

  // Prerequisites intent: LD-native — attach the parent flag(s) as prerequisites
  // and turn this flag ON serving treatment. It then releases exactly when its
  // parents do; no automated release is started.
  if (intent.prerequisites && intent.prerequisites.length > 0) {
    const instructions: Array<Record<string, unknown>> = [];
    for (const p of intent.prerequisites) {
      let parent: { data: FlagVariations };
      try {
        parent = await ld.getFlag<FlagVariations>(p.flagKey, `?env=${encodeURIComponent(environmentKey)}`);
      } catch {
        return {
          flagKey: flag.flagKey,
          method: "held",
          note: `releaseIntent prerequisite '${p.flagKey}' could not be read — held (fail-closed)${intentContext ? ` (${intentContext})` : ""}`,
        };
      }
      const want = (p.variation ?? "on") === "on";
      const parentVar = (parent.data.variations ?? []).find((v) => v.value === want);
      if (!parentVar) {
        return {
          flagKey: flag.flagKey,
          method: "held",
          note: `releaseIntent prerequisite '${p.flagKey}' has no boolean '${p.variation ?? "on"}' variation — held${intentContext ? ` (${intentContext})` : ""}`,
        };
      }
      instructions.push({ kind: "addPrerequisite", key: p.flagKey, variationId: parentVar._id });
    }
    instructions.push({ kind: "turnFlagOn" }, { kind: "updateFallthroughVariationOrRollout", variationId: onVar._id });
    await ld.patchFlagSemantic(
      flag.flagKey,
      environmentKey,
      instructions,
      "auto-factory: release via prerequisites (releaseIntent)",
    );
    return {
      flagKey: flag.flagKey,
      method: "prerequisites",
      note: `on behind prerequisites [${intent.prerequisites.map((p) => `${p.flagKey}=${p.variation ?? "on"}`).join(", ")}]${intentContext ? ` (${intentContext})` : ""}`,
    };
  }

  // Defaults precedence: manifest releasePlan > the flag's release policy > demo defaults.
  let policy: ReleasePolicy | null = null;
  try {
    policy = await getReleasePolicy(ld, flag.flagKey, environmentKey);
  } catch {
    policy = null; // policy read is best-effort; fall back to demo defaults
  }

  const ov = flag.releasePlan ?? flag.releaseOverrides ?? {};
  const metricKeys = ov.metricKeys ?? policy?.metricKeys ?? [];
  const metricGroupKeys = ov.metricGroupKeys ?? policy?.metricGroupKeys ?? [];
  const hasMetrics = metricKeys.length > 0 || metricGroupKeys.length > 0;

  const method: ReleaseKind =
    ov.releaseMethod ?? policy?.releaseMethod ?? (hasMetrics ? "guarded" : "progressive");

  if (method === "immediate") {
    await ld.patchFlagSemantic(
      flag.flagKey,
      environmentKey,
      [
        { kind: "turnFlagOn" },
        { kind: "updateFallthroughVariationOrRollout", variationId: onVar._id },
      ],
      "auto-factory: immediate release",
    );
    return { flagKey: flag.flagKey, method };
  }

  const metrics: MetricRef[] = [
    ...metricKeys.map((key) => ({ key, isGroup: false })),
    ...metricGroupKeys.map((key) => ({ key, isGroup: true })),
  ];
  const metricMonitoringPreferences: Record<string, { autoRollback: boolean }> = {};
  for (const m of metrics) metricMonitoringPreferences[m.key] = { autoRollback: true };

  const stages =
    ov.stages ?? policy?.stages ?? (method === "guarded" ? DEFAULT_GUARDED_STAGES : DEFAULT_PROGRESSIVE_STAGES);
  const usedDefaults = !ov.stages && !policy?.stages;

  await startRelease(ld, {
    flagKey: flag.flagKey,
    environmentKey,
    turnFlagOn: !flagIsOn,
    releaseKind: method,
    originalVariationId: offVar._id,
    targetVariationId: onVar._id,
    randomizationUnit: ov.randomizationUnit ?? policy?.randomizationUnit ?? DEFAULT_RANDOMIZATION_UNIT,
    stages,
    ...(ov.extensionDurationMillis !== undefined
      ? { extensionDurationMillis: ov.extensionDurationMillis }
      : {}),
    ...(method === "guarded" && metrics.length
      ? { metrics, metricMonitoringPreferences }
      : {}),
  });

  return {
    flagKey: flag.flagKey,
    method,
    ...(usedDefaults ? { note: "used demo default stages (no overrides or policy stages)" } : {}),
  };
}
