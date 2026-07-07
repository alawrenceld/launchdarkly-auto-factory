/**
 * Evidence for judges: the agent's ACTUAL changes, not its self-report.
 *
 * The judge otherwise sees only the brief the agent received and the agent's
 * final message — so a polished-but-wrong report could score well. This
 * collector gives the judge hook ground truth: a node-scoped `git diff` of
 * exactly the commits the just-finished agent landed.
 *
 * Node scoping works by snapshotting HEAD when the collector is created (before
 * the chain runs) and advancing the snapshot on every call: each call diffs
 * lastSeenHead..HEAD, which is precisely the commits made since the previous
 * judged node. "No new commits" is itself evidence (e.g. an honest skip).
 *
 * Defensive throughout: any git failure yields undefined (judge runs without
 * evidence) rather than breaking the evaluation.
 */

import { execFileSync } from "node:child_process";

/** Cap the evidence payload so judge prompts stay bounded. */
const MAX_EVIDENCE_CHARS = 24_000;

export type JudgeEvidenceCollector = (nodeKey: string) => Promise<string | undefined>;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function truncate(s: string): string {
  return s.length > MAX_EVIDENCE_CHARS ? `${s.slice(0, MAX_EVIDENCE_CHARS)}\n…[evidence truncated]` : s;
}

/**
 * Create a collector rooted at `cwd` (the repo the agents commit to). Returns a
 * collector that always yields undefined when `cwd` isn't a usable git checkout.
 */
export function createGitDiffEvidence(cwd: string): JudgeEvidenceCollector {
  let lastSeenHead: string | undefined;
  try {
    lastSeenHead = git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    console.warn(`[judge] evidence disabled: '${cwd}' is not a git checkout`);
    return async () => undefined;
  }

  return async (nodeKey: string) => {
    try {
      const prev = lastSeenHead;
      if (!prev) return undefined;
      const head = git(cwd, ["rev-parse", "HEAD"]);
      if (head === prev) {
        return `The agent landed NO new commits during this step (repository HEAD unchanged at ${head.slice(0, 12)}).`;
      }
      const range = `${prev}..${head}`;
      const log = git(cwd, ["log", "--format=%h %an: %s", range]);
      const stat = git(cwd, ["diff", "--stat", prev, head]);
      const patch = git(cwd, ["diff", prev, head]);
      lastSeenHead = head;
      return truncate(
        `Commits landed by this step (${range}):\n${log}\n\nFiles changed:\n${stat}\n\nFull diff:\n${patch}`,
      );
    } catch (e) {
      console.warn(`[judge] evidence collection failed for '${nodeKey}' (non-fatal): ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  };
}
