# LaunchDarkly AutoFactory

Prototype of autonomous, safe software releases. A chain of LaunchDarkly-defined AI agents
turns a plain pull request into a feature-flagged, metric-instrumented, tested change, and a
release orchestrator turns the eventual deploy into a guarded rollout that monitors itself.

Status: working prototype, shared with design partners. Phase 1 and Phase 2 both run
end-to-end against a live demo repo. Not a product.

## How it works

- **Phase 1 (per change):** resolve an agent graph and five agent configs from LaunchDarkly
  and walk the chain: research and classify the change, create a feature flag (targeting
  off), wire the new behavior behind it, create guarded-release metrics and instrument their
  events, write flag-on/flag-off tests, and produce a review verdict. A release manifest
  (`.release-flags/…json`) records the flag, metrics, and rollout parameters. Phase 1 has two
  interchangeable front ends over one shared core: a **GitHub Action** (runs on a PR, commits
  to the PR branch) and a **Cursor/VS Code extension** (runs on your working tree from the
  editor, leaving edits for you to review and commit). See
  [packages/phase1-cursor-extension/](packages/phase1-cursor-extension/) for the editor path.
- **Phase 2 (after deploy):** Beacon, a small HTTP service, receives deploy webhooks,
  diffs `.release-flags/` between the deployed SHA and the previous one, and starts a
  guarded release for each new manifest (turning the flag on atomically). It then monitors
  the release to a terminal state: completed, reverted by a guardrail metric, or stopped.
- **Phase 3 (flag cleanup):** out of scope; existing LaunchDarkly functionality.

Node-by-node detail with the exact mechanics: [docs/pipeline-overview.html](docs/pipeline-overview.html).
Design history: [docs/adr/](docs/adr/).

## Repository layout

| Path | What it is |
|------|------------|
| `packages/shared/` | LD clients (REST + native SDK), the `AgentRunner` provider seam, the Anthropic runner and agent tools, the release adapter, and the provider-agnostic Phase 1 orchestration (graph walk + approval) |
| `packages/phase1-resource-factory/` | Phase 1 front end #1: the GitHub Action (PR context, PR comment) |
| `packages/phase1-cursor-extension/` | Phase 1 front end #2: the Cursor/VS Code extension (runs the chain on your working tree from the editor) |
| `packages/beacon/` | Phase 2 release orchestrator (webhooks, discovery, trigger, monitor) |
| `packages/config-bridge/` | CLI that provisions/syncs the agent configs and graph between LD projects |
| `config/agentcontrol/ai-configs/` | The five agent definitions (instructions live here and in LD) |
| `config/agentcontrol/graphs/` | The agent graph: chain order, routing conditions, per-agent write capabilities |
| `bootstrap/` | One-command setup plus the drop-in workflow template |
| `examples/demo-app/` | Local sandbox the agents run against in dry-run mode |
| `docs/` | Pipeline overview, ADRs, design docs |

## Phase 1 setup

### Prerequisites

- Node 20+
- A LaunchDarkly account with **two projects**:
  - a **factory** project, which holds the agent configs and graph (the pipeline reads from it)
  - an **app** project, where the agents create flags and metrics (the pipeline writes to it)
- A LaunchDarkly server SDK key for the factory project's environment, and an API access
  token with write access to both projects
- An Anthropic API key (the default agent execution backend)
- A GitHub repository for your application

### 1. Provision the agent configs and graph

```bash
git clone <this repo> && cd launchdarkly-auto-factory
npm install
cp .env.example .env    # fill in LD_SDK_KEY, LD_API_KEY, LD_PROJECT_KEY, LD_APP_PROJECT_KEY, ANTHROPIC_API_KEY
npm run bootstrap
```

Bootstrap runs preflight checks, then creates the five agent AI configs and the
`gha-auto-factory` agent graph in your factory project from the committed definitions in
`config/agentcontrol/`. It is idempotent: existing configs are left alone. After
provisioning, the agent instructions are editable in the LaunchDarkly UI; the pipeline reads
them at run time, so instruction changes take effect on the next PR without redeploying
anything.

### 2. Add the workflow to your app repo

Copy `bootstrap/github-action-template/auto-factory.yml` into your app repo at
`.github/workflows/auto-factory.yml` and replace `<owner>` with the org or user hosting this
repo. Then set, in the app repo:

| Kind | Name | Value |
|------|------|-------|
| secret | `LD_SDK_KEY` | factory project server SDK key |
| secret | `LD_API_KEY` | LD API token (writes flags/metrics in the app project) |
| secret | `ANTHROPIC_API_KEY` | Anthropic API key |
| variable | `LD_APP_PROJECT_KEY` | your app project key |

`GITHUB_TOKEN` is provided by Actions automatically. The workflow needs
`contents: write` and `pull-requests: write` (already set in the template).

### 3. Open a pull request

Write the change normally, with no flag. The chain runs on every PR
(opened/synchronize/reopened) and takes a few minutes. On a flag-worthy PR you get:

- a boolean flag in the app project, targeting **off** in all environments
- commits on the PR branch: flag wiring, metric instrumentation plus the release manifest,
  and flag-on/flag-off tests
- three guarded-release metrics (error, latency, business) wired to the instrumented events
- a summary comment on the PR and a check status

The check is green when the code reviewer approves and red when it rejects. A red check is a
review verdict, not a pipeline failure. PRs that do not need a flag (docs, dependency bumps,
config changes) short-circuit after the first agent.

### Behavior toggles

| Input | Default | Effect |
|-------|---------|--------|
| `enable_flag_creation` | `false` in the action, `true` in the template | create real flags/metrics vs. read-only dry run |
| `enable_code_changes` | `false` in the action, `true` in the template | allow agent commits to the PR branch |
| `approval_mode` | `yolo` | `yolo` (report verdict), `middle` (gate high risk), `manual` (always gate) |
| `graph_key` | `gha-auto-factory` | which agent graph to walk |

The `auto-factory-ai-provider` flag (factory project, string variations `anthropic`/`vega`)
selects the execution backend per run. It is optional: when the flag does not exist, the
pipeline defaults to `anthropic`.

## Phase 2 setup (Beacon)

Phase 2 works end-to-end but is not yet a self-serve install; expect to read code. Summary
of what a deployment involves (details in [packages/beacon/README.md](packages/beacon/README.md)):

1. **Host Beacon** anywhere that runs a container:
   `docker build -f packages/beacon/Dockerfile .` from the repo root. Required env:
   `BEACON_WEBHOOK_SECRET`, `GITHUB_TOKEN` (reads `.release-flags/` via the contents API),
   `LD_API_KEY`, `LD_PROJECT_KEY` (the app project), `LD_ENVIRONMENT_KEY`.
2. **Register your services** in `config/services.yaml`: side (frontend/backend), repo,
   and a status URL that returns the deployed SHA.
3. **Point a deploy webhook at it.** Generic contract: POST `/flag-releases` with
   `{service, sha, previousSha?, environment?}` and the shared secret. A Railway adapter
   exists at `/webhooks/railway` (secret as a query parameter, since Railway webhooks cannot
   set headers). Other CD systems need a similar small adapter or a curl step in the
   pipeline.
4. Beacon resolves `previousSha` from its own deploy-state store when the notification does
   not carry one, diffs the manifests, triggers releases (method precedence: manifest
   overrides, then the flag's release policy, then guarded-if-metrics), and monitors each
   release to completion.

Known limitations: agents do not yet write the `scope` field into manifests (everything
defaults to frontend scope, so the fullstack coordination path is unexercised); the
deploy-state store is a local JSON file (single instance, mount a volume to survive
redeploys); boolean flags only.

## Development

```bash
npm run build        # tsc project build
npm test             # unit + integration tests
npm run typecheck    # build + tests typecheck
npm run check:public # guard against committing internal material
```

Changes to the agent configs, the graph, or operational flags are logged in
`config/agentcontrol/CHANGELOG.md`. The committed config files are the canonical public
copies; if you edit instructions in LaunchDarkly, re-export them here.

## Note: this repo is public

`reference-private/` and `sources/repos/` are gitignored. Internal material must never be
committed; `npm run check:public` enforces the obvious cases.
