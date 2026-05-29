/**
 * Thin LaunchDarkly REST client with a configurable base URL, so it can target
 * the prototype's project or any other instance. Uses global `fetch` (Node 18+).
 *
 * Auth header is the raw API key (LaunchDarkly convention — no "Bearer" prefix).
 */

import type { LdConnection } from "./env.js";

/** AI-config / agent-graph endpoints require the beta API version. */
const BETA = { "LD-API-Version": "beta" } as const;

export interface LdRequestOptions {
  method?: string;
  /** Path beginning with "/" (e.g. "/api/v2/flags/default/my-flag"). */
  path: string;
  body?: unknown;
  /** Extra headers (e.g. semantic-patch content-type, LD-API-Version). */
  headers?: Record<string, string>;
  /** Treat these status codes as success in addition to 2xx (e.g. [409]). */
  okStatuses?: number[];
}

export interface LdResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
}

export class LdClient {
  constructor(private readonly conn: LdConnection) {}

  get projectKey(): string {
    return this.conn.projectKey;
  }

  async request<T = unknown>(opts: LdRequestOptions): Promise<LdResponse<T>> {
    const res = await fetch(`${this.conn.baseUrl}${opts.path}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: this.conn.apiKey,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* leave as text */
      }
    }

    const ok = res.ok || (opts.okStatuses?.includes(res.status) ?? false);
    if (!ok) {
      throw new LdApiError(opts.method ?? "GET", opts.path, res.status, data);
    }
    return { status: res.status, ok, data: data as T };
  }

  /** GET a feature flag (optionally with environment summary). */
  getFlag<T = unknown>(flagKey: string, query = ""): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}${query}`,
    });
  }

  // --- AI configs & agent graphs (beta) -----------------------------------
  // The AI-config / agent-graph endpoints require the beta API version.

  /** Get an AI config; returns status 404 (not throwing) when absent. */
  getAiConfig<T = unknown>(key: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${key}`,
      headers: BETA,
      okStatuses: [404],
    });
  }

  createAiConfig<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs`,
      headers: BETA,
      body,
    });
  }

  createAiConfigVariation<T = unknown>(configKey: string, body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/ai-configs/${configKey}/variations`,
      headers: BETA,
      body,
    });
  }

  /** Get an agent graph; returns status 404 (not throwing) when absent. */
  getAgentGraph<T = unknown>(key: string): Promise<LdResponse<T>> {
    return this.request<T>({
      path: `/api/v2/projects/${this.conn.projectKey}/agent-graphs/${key}`,
      headers: BETA,
      okStatuses: [404],
    });
  }

  createAgentGraph<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/projects/${this.conn.projectKey}/agent-graphs`,
      headers: BETA,
      body,
    });
  }

  // --- Flags & metrics ------------------------------------------------------

  /** Create a feature flag. Returns status 409 (not throwing) when it exists. */
  createFlag<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/flags/${this.conn.projectKey}`,
      body,
      okStatuses: [409],
    });
  }

  /** Create a metric. Returns status 409 (not throwing) when it exists. */
  createMetric<T = unknown>(body: unknown): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "POST",
      path: `/api/v2/metrics/${this.conn.projectKey}`,
      body,
      okStatuses: [409],
    });
  }

  /**
   * Apply a semantic-patch instruction set to a flag.
   * See releaseAdapter.ts for building automated-release instructions.
   */
  patchFlagSemantic<T = unknown>(
    flagKey: string,
    environmentKey: string,
    instructions: unknown[],
    comment?: string,
  ): Promise<LdResponse<T>> {
    return this.request<T>({
      method: "PATCH",
      path: `/api/v2/flags/${this.conn.projectKey}/${flagKey}`,
      headers: { "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch" },
      body: { environmentKey, instructions, ...(comment ? { comment } : {}) },
    });
  }
}

export class LdApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`LD API ${method} ${path} failed: HTTP ${status} — ${JSON.stringify(responseBody)}`);
    this.name = "LdApiError";
  }
}
