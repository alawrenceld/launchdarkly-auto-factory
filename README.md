# LaunchDarkly Auto-Factory

An early **prototype** of fully autonomous, safe software releases using LaunchDarkly as the
primary production safety layer. Shared with early design partners; directionally accurate but
not the final product.

- **Phase 1 — Automatic resource creation:** in CI, a graph of agents researches a PR, decides
  whether it needs a flag, and (if so) creates the flag + metrics and wires them into the code,
  gated by an approval mode. Execution is provider-agnostic: the `auto-factory-ai-provider`
  LaunchDarkly flag selects the backend — the **default is a local Anthropic tool-use loop**;
  LaunchDarkly-hosted **Vega** is the alternative. Either way the LD AI SDK resolves the agent
  configs + graph and records metrics natively.
- **Phase 2 — Automatic releases:** after deploy, **Beacon** receives deploy notifications,
  discovers newly-added release flags, routes by scope, and triggers releases.
- **Phase 3 — Cleanup:** out of scope (already exists in LaunchDarkly).

See **[docs/plan.html](docs/plan.html)** for the design and **[docs/adr/](docs/adr/)** for the
architectural decision records.

## Status

Actively-developed prototype — **not finished**. Phase 1 runs **end-to-end today** on the default
Anthropic provider against a live demo repo: PR → agent chain → flag created → code wired → tests →
review → approval decision. Implemented and tested: the shared LD client + release adapter, the
provider seam (`AgentRunner`) with the Anthropic runner + sandbox tools + LD writer, the Vega
client/transport, the config bridge (provision / sync / seed), the Phase 1 graph walker + GitHub
Action, Beacon (discovery / scope routing / fullstack / release trigger), the Notifier, and
bootstrap. `npm test`, `npm run typecheck`, and `npm run check:public` are green.

Still genuinely open: Vega entitlement (the hosted-agent path is preserved but blocked on a live
dispatch endpoint); Phase 2 live-deploy validation; reading the approval mode from a per-repo LD
flag (it's an env var / action input today).

## Quickstart

```bash
npm install
cp .env.example .env        # fill in LD_SDK_KEY, LD_API_KEY, LD_PROJECT_KEY, ANTHROPIC_API_KEY, …
npm run build
npm run bootstrap           # preflight checks + seed/provision agent configs into your LD project
```

Then drop `bootstrap/github-action-template/auto-factory.yml` into your app repo's
`.github/workflows/`, set the repo secrets, and open a PR.

Useful scripts: `npm run typecheck`, `npm test`, `npm run check:public` (public-leak guard).

## Layout

| Path | What it is |
|------|------------|
| `bootstrap/` | One-command setup that wires CI, the LD env, secrets shape, and a demo |
| `packages/config-bridge/` | Provisions / syncs / seeds agent configs+graphs between LD projects |
| `packages/phase1-resource-factory/` | GitHub Action: walks the agent graph through the selected provider |
| `packages/beacon/` | Phase 2 release orchestrator |
| `packages/shared/` | The prototype's core: `AgentRunner` seam, Anthropic runner + sandbox tools + LD writer, Vega client, native SDK bootstrap, types |
| `config/agentcontrol/` | Agent configs/graph surface + the **CHANGELOG** (see Conventions below) |
| `examples/demo-app/` | Monorepo demo: JS/TS frontend + Python backend |
| `sources/` | Vendored, pinned external references (public) |
| `reference-private/` | **gitignored** — proprietary source material we draw inspiration from |

**Conventions:** changes to the AI configs, the agent graph, or operational flags are logged in
`config/agentcontrol/CHANGELOG.md`.

## Important: this repo is public

`reference-private/` and `sources/repos/` are gitignored. Proprietary material (the internal
build, internal specs, real configs) lives only in `reference-private/` and must never be
committed. See `docs/plan.html` §4 for the public/private boundary.
