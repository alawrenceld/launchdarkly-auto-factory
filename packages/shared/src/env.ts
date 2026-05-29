/**
 * Minimal environment loading. Reads a repo-root `.env` (if present) and
 * `process.env`, then exposes typed accessors for the LaunchDarkly connection.
 *
 * No dependency on dotenv — `.env` is parsed with a small KEY=VALUE reader so
 * the package stays light. Real secrets only ever come from the environment.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/** Parse and merge a `.env` file into process.env (does not overwrite existing). */
export function loadDotEnv(repoRoot: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Connection details for a LaunchDarkly instance/project. */
export interface LdConnection {
  apiKey: string;
  baseUrl: string;
  projectKey: string;
}

/** The target project the prototype reads from and writes to. */
export function targetConnection(): LdConnection {
  loadDotEnv();
  return {
    apiKey: required("LD_API_KEY"),
    baseUrl: (process.env.LD_BASE_URL || "https://app.launchdarkly.com").replace(/\/+$/, ""),
    projectKey: required("LD_PROJECT_KEY"),
  };
}

/**
 * Optional source project the bridge can pull starting configs+graphs from.
 * Returns null when not configured (the common case — provision from local copies).
 */
export function sourceConnection(): LdConnection | null {
  loadDotEnv();
  const apiKey = process.env.LD_SOURCE_API_KEY;
  const baseUrl = process.env.LD_SOURCE_BASE_URL;
  const projectKey = process.env.LD_SOURCE_PROJECT_KEY;
  if (!apiKey || !baseUrl || !projectKey) return null;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), projectKey };
}
