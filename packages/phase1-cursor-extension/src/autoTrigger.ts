/**
 * Automatic execution. Watches the editor's git repositories (via the built-in
 * vscode.git extension API) and, when a new commit lands on a non-base branch,
 * fires Phase 1 according to the `autoRun` setting:
 *   off    – never (button/command only)
 *   prompt – offer a "Run" notification (default)
 *   auto   – run immediately
 *
 * Commit-granularity is the closest local analog to the Action's "PR
 * synchronize" trigger: it fires on a unit of finished work, not on every
 * keystroke or save.
 */

import * as vscode from "vscode";

// Minimal shape of the built-in git extension API (avoids a type dependency).
interface GitHead {
  name?: string;
  commit?: string;
}
interface GitRepo {
  rootUri: vscode.Uri;
  state: { HEAD?: GitHead; onDidChange: vscode.Event<void> };
}
interface GitApi {
  repositories: GitRepo[];
  onDidOpenRepository: vscode.Event<GitRepo>;
}
interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

type AutoMode = "off" | "prompt" | "auto";

function autoMode(): AutoMode {
  return vscode.workspace.getConfiguration("launchdarkly-autofactory").get<AutoMode>("autoRun", "prompt");
}

function baseBranch(): string {
  return vscode.workspace.getConfiguration("launchdarkly-autofactory").get<string>("baseBranch", "main");
}

/**
 * Wire up auto-execution. `trigger(reason)` runs Phase 1 (the same entry point
 * the button uses); it is the caller's job to no-op when a run is already in
 * flight. Returns a disposable that tears down all watchers.
 */
export function registerAutoTrigger(trigger: (reason: string) => void): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const lastCommit = new Map<string, string | undefined>();
  const timers = new Map<string, NodeJS.Timeout>();

  const gitExt = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!gitExt) return new vscode.Disposable(() => undefined);

  void gitExt.activate().then((exports) => {
    let api: GitApi;
    try {
      api = exports.getAPI(1);
    } catch {
      return;
    }

    const watch = (repo: GitRepo): void => {
      const id = repo.rootUri.toString();
      lastCommit.set(id, repo.state.HEAD?.commit);
      disposables.push(
        repo.state.onDidChange(() => {
          if (autoMode() === "off") return;
          const head = repo.state.HEAD;
          const commit = head?.commit;
          const branch = head?.name;
          if (!commit || !branch || branch === baseBranch()) return;
          if (commit === lastCommit.get(id)) return; // HEAD didn't actually move
          lastCommit.set(id, commit);

          // Debounce: a commit fires several state changes in quick succession.
          const existing = timers.get(id);
          if (existing) clearTimeout(existing);
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              const mode = autoMode();
              if (mode === "auto") {
                trigger(`new commit on ${branch}`);
              } else if (mode === "prompt") {
                void vscode.window
                  .showInformationMessage(
                    `LaunchDarkly AutoFactory: run Phase 1 on the latest commit to "${branch}"?`,
                    "Run",
                    "Not now",
                  )
                  .then((choice) => {
                    if (choice === "Run") trigger(`new commit on ${branch}`);
                  });
              }
            }, 1500),
          );
        }),
      );
    };

    api.repositories.forEach(watch);
    disposables.push(api.onDidOpenRepository(watch));
  });

  return new vscode.Disposable(() => {
    for (const t of timers.values()) clearTimeout(t);
    disposables.forEach((d) => d.dispose());
  });
}
