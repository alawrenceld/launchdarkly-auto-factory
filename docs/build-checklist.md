# LaunchDarkly Auto-Factory — Build Checklist

A comprehensive, checklisted task list for building the prototype. Derived from `docs/plan.html`
and the reference materials. The reference build is **inspiration, not a rigid pattern** — where the
internal system leans on internal-only infrastructure (a specific CD system, internal auth, internal
service names), the prototype substitutes the lightweight, public-friendly equivalent.

**Milestones map to the build order in `plan.html` §10.** Work top to bottom; later milestones depend
on earlier ones. Spikes (§S) should be resolved before the milestone that depends on them.

---

## Legend

- `[ ]` not started · `[~]` in progress · `[x]` done
- 🔬 **spike** (resolve an unknown before committing to the design)
- ⚠️ **public-repo hygiene** (must not leak internal names/material)

---

## Already done (carried over)

- [x] Repo scaffold: `packages/`, `config/`, `bootstrap/`, `examples/`, `sources/`, `reference-private/`
- [x] `.gitignore` (covers `reference-private/`, `sources/repos/`, `.env`) — verified ignoring
- [x] `.env.example`, `config/ld-targets.yaml`, `config/scopes.yaml`, `config/release-source.yaml`
- [x] Reference materials organized under `reference-private/phase-1` and `phase-2`
- [x] One-off: fairytale AI configs + `gha-fairy-tale` graph cloned into target LD project
      (`auto-factory-prototype`); 15/20 variations (tools + one snippet still pending re-attach in LD)

---

## §S — Spikes to resolve first (gate the milestones noted)

- [ ] 🔬 **Public Vega dispatch API + auth** *(gates M6 / Phase 1)*
  - [ ] Confirm the public/partner-facing endpoint to dispatch an agent graph against an LD project
  - [ ] Confirm auth model for that endpoint (token type, headers) for an external partner
  - [ ] Confirm dispatch is async (dispatch → poll status) and capture request/response shapes
  - [ ] Confirm how PR context is passed and how the graph (`gha-fairy-tale`) is referenced
- [x] 🔬 **LD release API** *(RESOLVED — spec in `reference-private/internal-apis/`)*
  - Trigger = a **semantic-patch** instruction (`startAutomatedRelease`, kind `guarded`/`progressive`)
    on the standard flag PATCH endpoint; stop via `stopAutomatedRelease`.
  - Monitor = the **automated-releases** status endpoint (read the release object until terminal).
  - ⚠️ These read endpoints are **internal-for-now + require `LD-API-Version: beta`** and are mid-rename
    (will go public, shape may change) → **isolate behind the M2 release adapter** so the path/shape
    change lands in one place.
  - [ ] Confirm where a flag's "release policy" lives and how to read it (+ override precedence)
- [ ] 🔬 **Agent-graph CRUD via API** *(gates M3 bridge)* — MCP exposes AI-config CRUD; confirm graph
      create/update path (else push graphs via REST)
- [ ] **Decide code-delivery mechanism** for the flagging agent's code changes: GitHub suggestions,
      stacked PR, or bot commit — and the CI-loop guard for it (see `plan.html` §8)

---

## M1 — Public/private guardrails ⚠️

- [ ] Add `scripts/check-public`: fail if internal identifiers / internal tool names / `reference-private`
      content appear in tracked files (run in pre-commit and CI)
- [ ] Wire `check-public` into a CI workflow on PRs to this repo
- [ ] `README.md` reviewed for any internal references; confirm `reference-private/` never tracked
- [ ] Establish the sanitization rule: agent instructions/prompts ported into the public repo are
      reviewed for proprietary release logic before commit

---

## M2 — Shared package (`packages/shared/`)

- [x] Monorepo workspace (npm workspaces + TypeScript, Node 20, `tsc --build`); `shared` compiles
- [x] LD API client with **configurable base URL** (target vs. any instance), token from env (`LdClient`)
- [~] Typed wrappers: flags get + semantic patch done; **metrics + AI-config/agent-graph wrappers pending**
      (added alongside the bridge in M3)
- [x] **Release adapter** (`releaseAdapter.ts`): `startAutomatedRelease`/`stopAutomatedRelease` builder +
      semantic patch + automated-releases status read/monitor. Beta/internal endpoints quarantined
      (`LD-API-Version: beta`, single `automatedReleasesPath()` to change when public)
- [x] Config schemas/loaders: `scopes.yaml`, `release-source.yaml` (`config.ts`); LD conns from env (`env.ts`)
- [x] Shared types (`types.ts`): `Scope`, `ReleaseKind`, `Stage`, `MetricRef`, `ReleaseOverrides`,
      `ReleaseFlagFile`/`DiscoveredFlag`, `ApprovalMode`, `RiskLevel`, `DeployNotification`
- [x] **Vega client interface** (`vegaClient.ts`): stable `VegaTransport` seam + `VegaClient` poll loop;
      `StubVegaTransport` throws until real API docs land (PLACEHOLDER, isolated)
- [ ] Unit tests for the client (mocked HTTP), the release-instruction builder, and config loaders

---

## M3 — Config bridge (`packages/config-bridge/`)

- [ ] Port the working one-off creator into a real `provision` command (configs + variations + graph,
      idempotent: GET-then-create, backfill missing)
- [ ] `sync` command: refresh canonical local copies from a configurable **source** instance
- [ ] Canonical starting configs + graphs committed under `config/agentcontrol/` (sanitized) ⚠️
- [ ] Handle dependencies surfaced during the one-off: **tools** registration and **prompt snippets**
      must exist in target before tool/snippet-bearing variations create (provision them, or document
      the manual step)
- [ ] Resolve agent-graph CRUD per §S
- [ ] Dry-run mode (print planned changes without writing)
- [ ] Tests against a throwaway project or mocked API

---

## M4 — Bootstrap / easy-setup (`bootstrap/`)

- [ ] `create.*` one-command setup: collect/validate config, provision LD env via the bridge, scaffold
      the GitHub Action into the target repo, print next steps
- [ ] `bootstrap/checks/` preflight: tokens present, LD reachable, project/env valid, scopes parse —
      fail loudly with the fix
- [ ] `bootstrap/github-action-template/`: drop-in PR workflow a partner copies
- [ ] Generate **real, legible config files** the partner can edit (defaults one layer deep, no magic)
- [ ] Document the setup in `README.md` (clone → bootstrap → working demo)

---

## M5 — Demo app (`examples/demo-app/`)

- [ ] `frontend/` — minimal JS/TS app with at least one flag-guardable feature
- [ ] `backend/` — minimal Python service with at least one flag-guardable endpoint
- [ ] Both deploy as **independent Railway services**, each emitting a post-deploy notification
- [ ] Each service exposes a status endpoint reporting its deployed SHA (for fullstack coordination)
- [ ] A `.release-flags/` directory convention demonstrated in the demo repo
- [ ] Seed the demo flags/metrics in the target LD project (via bridge or scripted)

---

## M6 — Phase 1: resource creation (GitHub Action → Vega)

Depends on §S (Vega API). The chain is **5 sequential agents**:
research → flagging → **metrics** → testing → review. The reference build ships only four
(metrics is not yet a separate config), so the **metrics agent is authored new** — it is a core node,
not an optional enhancement.

- [ ] `packages/phase1-resource-factory/github-action/`: assemble PR context (diff, files, metadata)
- [ ] Dispatch to Vega: **async dispatch + poll to terminal status**; pass PR context; reference the
      agent graph
- [ ] **Trigger on PR opened/synchronized** — runs automatically on every PR, **no label gate**
      (deliberate divergence from the reference, for minimal dev friction / max splash). A path or size
      filter may be added later to skip trivial PRs, but the default is: open a PR, the magic happens.
- [ ] Walk the agent graph: follow edges, honor handoff conditions (skip-if / require tags), thread each
      node's output to the next
- [ ] `adapters/ci-github/`: read PR, post a status/summary comment with run results
- [ ] `adapters/ld/`: idempotent flag + metric creation (stable keys derived from PR/feature → re-runs
      are no-ops)
- [ ] `agents/`: sanitized local copies of each agent's instructions ⚠️ (research, flagging, metrics,
      testing, review)
- [ ] **Author the metrics agent** (no reference config exists): write its instructions (what to
      measure, event instrumentation, tie metrics to the flag's release), create the AI config, and
      **extend the agent graph** to insert it after flagging (handoff carries the created flag key)
- [ ] **Approval mode from a LaunchDarkly flag**, scoped per-repo, default **Yolo**; hardcoded fallback
  - [ ] Yolo: auto-apply on APPROVE
  - [ ] Manual: require human approval in GitHub
  - [ ] Middle: gate on the research agent's risk score (thresholds deferred)
- [ ] Code-delivery mechanism implemented per §S decision, with the CI-loop guard
- [ ] End-to-end test on a real demo PR (label → flag+metric created + code wired → approved)

---

## M7 — Phase 2: automatic releases (Notifier + Beacon)

Concept-map of the reference: **Beacon calls the LD release API directly** instead of invoking a CD
pipeline system.

### Notifier (post-deploy)
- [ ] Railway post-deploy hook that POSTs `{sha, previous_sha, service, environment}` to Beacon
- [ ] Authenticated with a shared secret header; **non-blocking** (never delays deploys)

### Beacon (`packages/beacon/`)
- [ ] HTTP endpoint (e.g. `POST /flag-releases`) with shared-secret auth
- [ ] **Discovery**: diff `.release-flags/` at `previous_sha` vs `sha` via GitHub Contents API → new files
- [ ] Parse `.release-flags/pr-N.json` → `{flagKey, scope, releaseOverrides}`
- [ ] **Scope routing** (`config/scopes.yaml`, generalized — not hardcoded service names):
  - [ ] single-service scope → trigger
  - [ ] other-service scope → skip
  - [ ] fullstack → cross-service check
- [ ] **Fullstack coordination** (stateless): read the other service's deployed SHA from its status
      endpoint, verify the same `.release-flags/` file is present there; trigger if yes, skip if no
- [ ] **Release trigger** → call the M2 release adapter (`startAutomatedRelease` semantic patch):
  - [ ] map release method: immediate (plain targeting flip) vs. `releaseKind` progressive / guarded
  - [ ] apply release policy (read from flag) with `.release-flags` overrides taking precedence
  - [ ] build the instruction: `originalVariationId`/`targetVariationId`, placement (fallthrough vs.
        `ruleId`/`ref`/new-rule `clauses`), `randomizationUnit`, `stages` `{allocation, durationMillis}`,
        optional `extensionDurationMillis` (guarded), `metrics` `{key, isGroup}` +
        `metricMonitoringPreferences` `{metricKey: {autoRollback}}`
- [ ] **Monitor** the automated release to completion via the adapter (poll status until terminal —
      `completed` / `reverted` / stopped; surface stage progress and regressions)
- [ ] **Backstop** for the fullstack "wait" path: retry/timeout so a lost notification can't strand a
      release (see `plan.html` §8)
- [ ] `release-source` adapter so `.release-flags`-in-repo can later be swapped for an LD-native source
- [ ] Tests: discovery diff, scope routing matrix, fullstack present/absent, trigger payload, monitor

---

## M8 — Fullstack end-to-end + hardening

- [ ] Full demo run: PR (Phase 1) → merge → deploy both services → Beacon coordinates fullstack →
      guarded rollout starts → monitored to completion
- [ ] Idempotency/repeat-notification safety verified end to end
- [ ] Observability: structured logs + a minimal trace of a release decision

---

## Cross-cutting (throughout)

- [ ] ADRs in `docs/adr/` for real decisions (Vega dispatch shape, release-trigger-via-LD-API,
      scope generalization, code-delivery mechanism)
- [ ] Keep `docs/plan.html` in sync if a decision changes the design shape
- [ ] `sources/manifest.yaml` populated for any public references actually used
- [ ] Secrets only via env / CI secrets; `.env.example` kept current
- [ ] README "quickstart" stays true to the bootstrap flow as it evolves

---

## Notable refinements from the source (folded into the tasks above)

1. **Phase 1 is a sequential agent chain on Vega**, dispatched async; the GitHub Action walks the
   graph. The reference build has 4 agents and is label-gated; the prototype **(a)** adds a **5th core
   agent, metrics** (research → flagging → metrics → testing → review), authored since no reference
   config exists, and **(b)** **triggers on every PR open (no label gate)** for minimal dev friction.
   The live Vega dispatch endpoint/auth are **placeholders** until the team provides real API docs.
2. **Phase 2's "trigger" is a guarded/progressive measured rollout** via LD's release API, driven by a
   release policy + per-release overrides — not a simple flag flip. The prototype calls LD directly,
   collapsing the internal CD-pipeline hop.
3. **Scope routing is generalized** in the prototype (the reference hardcodes specific service names).
