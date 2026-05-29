/**
 * Assemble PR context for the agent chain from the GitHub Actions environment.
 * Reads the event payload (GITHUB_EVENT_PATH) when available, with env fallbacks.
 */

import { existsSync, readFileSync } from "node:fs";

export interface PrContext {
  PR_NUMBER?: string;
  PR_TITLE?: string;
  PR_BODY?: string;
  REPO?: string;
  SHA?: string;
  [key: string]: unknown;
}

export function assemblePrContext(): PrContext {
  const ctx: PrContext = {
    REPO: process.env.GITHUB_REPOSITORY,
    SHA: process.env.GITHUB_SHA,
  };

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        pull_request?: { number?: number; title?: string; body?: string };
      };
      const pr = event.pull_request;
      if (pr) {
        if (pr.number !== undefined) ctx.PR_NUMBER = String(pr.number);
        if (pr.title) ctx.PR_TITLE = pr.title;
        if (pr.body) ctx.PR_BODY = pr.body;
      }
    } catch {
      /* fall through to env */
    }
  }

  // Explicit input overrides (action.yml inputs are exposed as INPUT_* / env).
  ctx.PR_NUMBER = process.env.PR_NUMBER ?? ctx.PR_NUMBER;
  ctx.PR_TITLE = process.env.PR_TITLE ?? ctx.PR_TITLE;
  ctx.PR_BODY = process.env.PR_BODY ?? ctx.PR_BODY;

  return ctx;
}
