/**
 * Builds the change context the agent chain consumes, from the local working
 * tree instead of a GitHub pull request. The shape matches what the graph
 * walker's prompt builder and the AI SDK's instruction interpolation expect
 * (REPO / PR_TITLE / PR_BODY / PR_NUMBER / PR_BRANCH), so the agents run
 * unchanged; only the source of the values differs.
 *
 * There is no PR number locally, so the branch name (sanitized) stands in for
 * it — it becomes the release-manifest id (`.release-flags/pr-<branch>.json`),
 * which Phase 2 discovers by file presence, not by the number itself.
 */

import { lastCommit, type RepoState } from "./git.js";

export interface CursorContext extends Record<string, unknown> {
  REPO?: string;
  PR_NUMBER?: string;
  PR_TITLE?: string;
  PR_BODY?: string;
  PR_BRANCH?: string;
  SHA?: string;
}

export async function buildCursorContext(workspaceRoot: string, state: RepoState): Promise<CursorContext> {
  const { subject, body } = await lastCommit(workspaceRoot);
  const branch = state.branch;
  const slug = (branch ?? "working-tree").replace(/[^a-zA-Z0-9._-]/g, "-");
  return {
    REPO: state.repoSlug,
    PR_BRANCH: branch,
    PR_NUMBER: slug,
    PR_TITLE: subject ?? branch ?? "Local changes",
    PR_BODY: body ?? "",
    SHA: state.head,
  };
}

/** Interpolation variables for the AI SDK (mirrors the Action's buildVariables). */
export function buildContextVariables(ctx: CursorContext, appProjectKey: string): Record<string, unknown> {
  return {
    PR_NUMBER: ctx.PR_NUMBER ?? "",
    PR_TITLE: ctx.PR_TITLE ?? "",
    PR_BODY: ctx.PR_BODY ?? "",
    REPO: ctx.REPO ?? "",
    PR_BRANCH: ctx.PR_BRANCH ?? "",
    TICKET_ID: "",
    LAUNCHDARKLY_PROJECT: appProjectKey,
  };
}
