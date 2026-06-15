/**
 * Small git helpers over the workspace. Uses plain `git` via child_process
 * (every Cursor workspace that this is meaningful for is a git repo). Read-only:
 * nothing here mutates the repo — the agents' edits land via the sandbox tools.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export interface RepoState {
  /** Current branch name, or undefined when detached. */
  branch?: string;
  /** Short HEAD SHA. */
  head?: string;
  /** Commits on HEAD not on the base branch. */
  aheadOfBase: number;
  /** Working-tree changes (porcelain lines): staged, unstaged, untracked. */
  dirtyFiles: number;
  /** The base ref that was resolvable, if any. */
  resolvedBase?: string;
  /** owner/name parsed from the origin remote, if any. */
  repoSlug?: string;
}

/** Whether `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** First base candidate that exists locally (origin/<base>, <base>, origin/main, main). */
async function resolveBase(cwd: string, base: string): Promise<string | undefined> {
  for (const ref of [`origin/${base}`, base, "origin/main", "main"]) {
    try {
      await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function parseSlug(remoteUrl: string): string | undefined {
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const m = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/);
  return m?.[1];
}

export async function readRepoState(cwd: string, base: string): Promise<RepoState> {
  const state: RepoState = { aheadOfBase: 0, dirtyFiles: 0 };
  try {
    state.branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || undefined;
    if (state.branch === "HEAD") state.branch = undefined; // detached
    state.head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  } catch {
    /* empty repo / no commits */
  }
  state.resolvedBase = await resolveBase(cwd, base);
  if (state.resolvedBase) {
    try {
      const n = await git(cwd, ["rev-list", "--count", `${state.resolvedBase}..HEAD`]);
      state.aheadOfBase = Number(n) || 0;
    } catch {
      /* */
    }
  }
  try {
    const porcelain = await git(cwd, ["status", "--porcelain"]);
    state.dirtyFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  } catch {
    /* */
  }
  try {
    state.repoSlug = parseSlug(await git(cwd, ["remote", "get-url", "origin"]));
  } catch {
    /* no origin */
  }
  return state;
}

/** Latest commit subject + body, for synthesizing a change title/description. */
export async function lastCommit(cwd: string): Promise<{ subject?: string; body?: string }> {
  try {
    const subject = await git(cwd, ["log", "-1", "--pretty=%s"]);
    const body = await git(cwd, ["log", "-1", "--pretty=%b"]);
    return { subject: subject || undefined, body: body || undefined };
  } catch {
    return {};
  }
}

/** True when there is something for Phase 1 to act on (commits ahead, or dirty). */
export function hasChangeToProcess(state: RepoState): boolean {
  return state.aheadOfBase > 0 || state.dirtyFiles > 0;
}
