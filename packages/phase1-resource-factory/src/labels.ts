/**
 * PR labels as the approval gesture for per-step gates (GitHub Action path).
 *
 * A gated agent node `<nodeKey>` is approved by adding the PR label
 * `af-approve:<nodeKey>`. Labels are chosen because they're the easiest on the
 * two axes that matter to approvers: at-a-glance visibility (pinned, color-coded
 * chips on the PR) and a two-click act (the Labels sidebar) that re-triggers the
 * workflow (`on: pull_request` with the `labeled` type). Approval persists across
 * later pushes, so nobody re-approves every commit.
 */

export const APPROVE_LABEL_PREFIX = "af-approve:";

/** The label a human adds to approve running `nodeKey`. */
export function approveLabel(nodeKey: string): string {
  return `${APPROVE_LABEL_PREFIX}${nodeKey}`;
}

const ghHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

/**
 * The set of node keys approved via labels on the PR. Best-effort: returns an
 * empty set if the token/repo/PR are missing or the API call fails (so a missing
 * label simply reads as "not approved").
 */
export async function fetchApprovedSteps(repo?: string, prNumber?: string, token?: string): Promise<Set<string>> {
  const approved = new Set<string>();
  if (!repo || !prNumber || !token) return approved;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/labels?per_page=100`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) return approved;
    const labels = (await res.json()) as Array<{ name?: string }>;
    for (const l of labels) {
      if (l.name?.startsWith(APPROVE_LABEL_PREFIX)) approved.add(l.name.slice(APPROVE_LABEL_PREFIX.length));
    }
  } catch {
    /* best-effort */
  }
  return approved;
}

/**
 * Pre-create an approval label (best-effort) so approvers can add it from the PR
 * sidebar without inventing it. A 422 (already exists) is fine.
 */
export async function ensureLabel(repo: string | undefined, name: string, token: string | undefined): Promise<void> {
  if (!repo || !token) return;
  try {
    await fetch(`https://api.github.com/repos/${repo}/labels`, {
      method: "POST",
      headers: ghHeaders(token),
      body: JSON.stringify({ name, color: "0e8a16", description: "AutoFactory: approve this gated step to proceed" }),
    });
  } catch {
    /* best-effort; label may already exist */
  }
}

/**
 * Who approved: the GitHub login that last added an `af-approve:*` label to the
 * PR (from the issue events timeline). Best-effort — undefined on any failure.
 * Feeds releaseIntent.approvedBy in the manifest.
 */
export async function fetchApprovalActor(
  repo?: string,
  prNumber?: string,
  token?: string,
): Promise<string | undefined> {
  const t = token ?? process.env.GITHUB_TOKEN;
  if (!t || !repo || !prNumber) return undefined;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/events?per_page=100`, {
      headers: ghHeaders(t),
    });
    if (!res.ok) return undefined;
    const events = (await res.json()) as Array<{
      event?: string;
      label?: { name?: string };
      actor?: { login?: string };
    }>;
    const labeled = events.filter(
      (e) => e.event === "labeled" && e.label?.name?.startsWith(APPROVE_LABEL_PREFIX) && e.actor?.login,
    );
    return labeled.length ? labeled[labeled.length - 1]?.actor?.login : undefined;
  } catch {
    return undefined;
  }
}
