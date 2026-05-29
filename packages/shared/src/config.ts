/**
 * Loaders for the `config/` customization surface: scopes and release-source.
 * (LD connection details come from env — see env.ts. The approval mode lives in
 * a LaunchDarkly flag, not a config file.)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Scope } from "./types.js";

/** A scope definition: which services must deploy before a release triggers. */
export interface ScopeDefinition {
  description?: string;
  services: string[];
}

export interface ScopesConfig {
  scopes: Record<Scope, ScopeDefinition>;
}

export interface ReleaseSourceConfig {
  /** Which release-config source is active. */
  active: "release-flags-dir" | "ld-native";
  "release-flags-dir"?: { path: string };
}

function readYaml<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  return parseYaml(readFileSync(path, "utf8")) as T;
}

export function loadScopes(repoRoot: string = process.cwd()): ScopesConfig {
  return readYaml<ScopesConfig>(resolve(repoRoot, "config/scopes.yaml"));
}

export function loadReleaseSource(repoRoot: string = process.cwd()): ReleaseSourceConfig {
  return readYaml<ReleaseSourceConfig>(resolve(repoRoot, "config/release-source.yaml"));
}

/** The directory release flags are read from (default `.release-flags/`). */
export function releaseFlagsDir(cfg: ReleaseSourceConfig): string {
  return cfg["release-flags-dir"]?.path ?? ".release-flags/";
}
