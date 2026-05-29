/**
 * Shared domain types for the LaunchDarkly Auto-Factory prototype.
 * Used across the config bridge, the Phase 1 GitHub Action, and Beacon (Phase 2).
 */

// ----------------------------------------------------------------------------
// Scope & release shape (Phase 2)
// ----------------------------------------------------------------------------

/** Which deploy path(s) must complete before a flag release triggers. */
export type Scope = "frontend" | "backend" | "fullstack";

/** How a flag is rolled out once its guarding code is deployed. */
export type ReleaseKind = "immediate" | "progressive" | "guarded";

/** A single rollout stage. `allocation` is in basis points (0–100000 = 0–100%). */
export interface Stage {
  allocation: number;
  durationMillis: number;
}

/** A metric attached to a guarded release. */
export interface MetricRef {
  key: string;
  /** True if `key` refers to a metric group rather than a single metric. */
  isGroup: boolean;
}

/**
 * Optional per-release overrides carried in a `.release-flags/*.json` file.
 * These take precedence over the flag's configured release policy.
 */
export interface ReleaseOverrides {
  releaseMethod?: ReleaseKind;
  randomizationUnit?: string;
  stages?: Stage[];
  /** Guarded-only; extends the final stage's monitoring window. */
  extensionDurationMillis?: number;
  metricKeys?: string[];
  metricGroupKeys?: string[];
}

/** The on-disk shape of a `.release-flags/*.json` file. */
export interface ReleaseFlagFile {
  flagKey: string;
  /** Defaults to "frontend" when omitted (matches reference behavior). */
  scope?: Scope;
  releaseOverrides?: ReleaseOverrides;
}

/** A release-flag file discovered during a deploy notification. */
export interface DiscoveredFlag extends ReleaseFlagFile {
  /** Repo-relative path of the file the flag was discovered in. */
  sourceFile: string;
}

// ----------------------------------------------------------------------------
// Approval modes (Phase 1)
// ----------------------------------------------------------------------------

/**
 * How the output of the agent chain is applied.
 * Stored in a LaunchDarkly flag (per-repo); defaults to "yolo".
 */
export type ApprovalMode = "yolo" | "middle" | "manual";

/** Risk score produced by the research agent; gates "middle" approval mode. */
export type RiskLevel = "low" | "medium" | "high";

// ----------------------------------------------------------------------------
// Deploy notification (Phase 2 — Notifier → Beacon)
// ----------------------------------------------------------------------------

/** Payload a post-deploy Notifier POSTs to Beacon. */
export interface DeployNotification {
  /** Newly-deployed commit SHA. */
  sha: string;
  /** Previously-deployed SHA; required to diff for newly-added release flags. */
  previousSha?: string;
  /** Logical service key (maps to a scope side). */
  service: string;
  /** Target environment key. */
  environment: string;
}
