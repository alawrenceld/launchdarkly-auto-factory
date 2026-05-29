/**
 * Post a summary comment on the PR. Best-effort and non-fatal: if the token /
 * repo / PR number aren't available, it logs and returns.
 */

export interface CommentTarget {
  prNumber?: string;
  repo?: string; // owner/name
  token?: string;
}

export async function postPrComment(body: string, target: CommentTarget = {}): Promise<void> {
  const token = target.token ?? process.env.GITHUB_TOKEN;
  const repo = target.repo ?? process.env.GITHUB_REPOSITORY;
  const prNumber = target.prNumber ?? process.env.PR_NUMBER;

  if (!token || !repo || !prNumber) {
    console.log("(PR comment skipped — missing token / repo / PR number)");
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
    console.log(res.ok ? "Posted PR summary comment." : `PR comment failed: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`PR comment error (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
