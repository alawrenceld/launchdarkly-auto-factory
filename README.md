# LaunchDarkly Auto-Factory

An early **prototype** of fully autonomous, safe software releases using LaunchDarkly as the
primary production safety layer. Shared with early design partners; directionally accurate but
not the final product.

- **Phase 1 — Automatic resource creation:** in CI, a graph of LaunchDarkly-hosted agents
  researches a PR, decides whether it needs a flag, and (if so) creates the flag + metrics and
  wires them into the code, gated by an approval mode.
- **Phase 2 — Automatic releases:** after deploy, **Beacon** receives deploy notifications,
  discovers newly-added release flags, routes by scope, and triggers releases.
- **Phase 3 — Cleanup:** out of scope (already exists in LaunchDarkly).

See **[docs/plan.html](docs/plan.html)** for the design, **[docs/build-checklist.md](docs/build-checklist.md)**
for build status, and **[docs/ISSUES.md](docs/ISSUES.md)** for known blocked/deferred items.

## Quickstart

```bash
npm install
cp .env.example .env        # fill in LD_API_KEY, LD_PROJECT_KEY, …
npm run build
npm run bootstrap           # preflight checks + provision agent configs into your LD project
```

Then drop `bootstrap/github-action-template/auto-factory.yml` into your app repo's
`.github/workflows/`, set the repo secrets, and open a PR.

Useful scripts: `npm run typecheck`, `npm test`, `npm run check:public` (public-leak guard).

## Layout

| Path | What it is |
|------|------------|
| `bootstrap/` | One-command setup that wires CI, the LD env, secrets shape, and a demo |
| `packages/config-bridge/` | Non-agentic tool that provisions agent configs+graphs into an LD env |
| `packages/phase1-resource-factory/` | Integration glue: GitHub Action that calls the LD-hosted agents |
| `packages/beacon/` | Phase 2 release orchestrator |
| `packages/shared/` | Shared types, LD client, config schemas |
| `config/` | The documented customization surface partners edit |
| `examples/demo-app/` | Monorepo demo: JS/TS frontend + Python backend |
| `sources/` | Vendored, pinned external references (public) |
| `reference-private/` | **gitignored** — proprietary source material we draw inspiration from |

## Important: this repo is public

`reference-private/` and `sources/repos/` are gitignored. Proprietary material (the internal
build, internal specs, real configs) lives only in `reference-private/` and must never be
committed. See `docs/plan.html` §4 for the public/private boundary.
