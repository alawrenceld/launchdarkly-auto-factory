# LaunchDarkly AutoFactory — Cursor/VS Code extension

Phase 1 of AutoFactory, run from the editor instead of (or alongside) the
GitHub Action. On your current changes it runs the same five-agent chain:
research and classify, create a feature flag (off), wire the code, create
guarded-release metrics and instrument their events, and write flag-on/flag-off
tests, then surface the reviewer's verdict.

The agents' edits land in your **working tree, uncommitted** — you review them
in the editor's SCM panel and commit yourself. Nothing is pushed.

## How it relates to the GitHub Action

Both front ends share one core (`@auto-factory/shared`: graph walk, agents,
tools, approval). They differ only at the edges:

| | GitHub Action | This extension |
|---|---|---|
| Trigger | PR opened/updated | Button, command, or a new commit on a feature branch |
| Change set | PR diff (base…head) | Working tree vs the base branch |
| Agent edits | committed + pushed to the PR | left in the working tree for review |
| Output | PR comment | output log + sidebar view + notification |

The Action is unaffected by this package; it is a separate, peer front end.

## Triggers

- **Button:** the rocket in the **AutoFactory** sidebar, the status-bar item, or
  the Source Control title bar.
- **Command:** `LaunchDarkly AutoFactory: Run on Current Changes`.
- **Automatic** (`launchdarkly-autofactory.autoRun`): on a new commit to a
  non-base branch — `off`, `prompt` (default; offers a notification), or `auto`.

## Configuration

Non-secret options are in Settings (`launchdarkly-autofactory.*`): factory and
app project keys, base URL, graph key, base branch, approval mode, the
flag-creation / code-changes toggles, and the auto-run mode.

API keys are stored in the editor's SecretStorage, never in settings.json. Run
**`LaunchDarkly AutoFactory: Set API Keys`** to enter them:

- LaunchDarkly server SDK key (`sdk-…`) for the factory project
- LaunchDarkly API token (`api-…`) — needed to create flags/metrics
- Anthropic API key

(If the editor was launched from a shell that already exports `LD_SDK_KEY` /
`LD_API_KEY` / `ANTHROPIC_API_KEY`, those are used as a fallback.)

## Running it from source

This is a prototype; it is not published to a marketplace. From the monorepo
root:

```bash
npm install
npm run build
npm run bundle -w @auto-factory/phase1-cursor-extension   # produces dist/extension.bundle.cjs
```

Then either:

- **Develop with F5:** open `packages/phase1-cursor-extension/` in Cursor/VS
  Code and create `.vscode/launch.json`:

  ```json
  {
    "version": "0.2.0",
    "configurations": [
      {
        "name": "Run AutoFactory Extension",
        "type": "extensionHost",
        "request": "launch",
        "args": ["--extensionDevelopmentPath=${workspaceFolder}"]
      }
    ]
  }
  ```

  Press F5; in the Extension Development Host window, open a git repo, set the
  API keys, and run.

- **Package a VSIX:** `npx @vscode/vsce package` in this directory, then install
  the `.vsix` via the Extensions view → "Install from VSIX…".

## What a run does

1. Builds the change context from the working tree (branch, last commit, repo).
2. Resolves the agent graph + agent instructions from LaunchDarkly (same configs
   the Action uses).
3. Walks the chain with the local Anthropic runner; `git_diff` reports the
   working tree vs the base branch, so each agent sees the prior agents'
   uncommitted edits.
4. Writes flag wiring, metric instrumentation, the release manifest
   (`.release-flags/…`), and tests into the working tree.
5. Shows the reviewer's verdict and risk. The approval mode is advisory here:
   the edits are already in your tree, so you decide what to commit.
