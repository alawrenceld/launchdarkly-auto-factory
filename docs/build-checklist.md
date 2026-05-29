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
- [x] One-off: the reference AI configs + agent graph cloned into the target LD project
      (`auto-factory-prototype`); 15/20 variations (tools + one snippet still pending re-attach in LD)

---

## §S — Spikes to resolve first (gate the milestones noted)

- [ ] 🔬 **Public Vega dispatch API + auth** *(gates M6 / Phase 1)*
  - [ ] Confirm the public/partner-facing endpoint to dispatch an agent graph against an LD project
  - [ ] Confirm auth model for that endpoint (token type, headers) for an external partner
  - [ ] Confirm dispatch is async (dispatch → poll status) and capture request/response shapes
  - [ ] Confirm how PR context is passed and how the agent graph is referenced
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

- [x] `scripts/check-public.mjs`: fails if internal infra instance/service identifiers appear in
      tracked files, or if anything under `reference-private/` is tracked. `npm run check:public`.
      (The exact blocklist lives in the script, not in docs — naming them here would trip the guard.)
- [x] Wired into `.github/workflows/ci.yml` (check:public + typecheck on PR/push)
- [x] Confirmed `reference-private/` never tracked (guard enforces); scrubbed accidental internal
      codename leaks from tracked files (caught two during calibration)
- [ ] Sanitization rule for ported agent instructions before public commit → tied to **ISSUES I3**

---

## M2 — Shared package (`packages/shared/`)

- [x] Monorepo workspace (npm workspaces + TypeScript, Node 20, `tsc --build`); `shared` compiles
- [x] LD API client with **configurable base URL** (target vs. any instance), token from env (`LdClient`)
- [x] Typed wrappers: flags (get/create/semantic-patch), metrics (create), AI-config (get/create +
      variations), agent-graph (get/create) — all on `LdClient` (beta header where required)
- [x] **Release adapter** (`releaseAdapter.ts`): `startAutomatedRelease`/`stopAutomatedRelease` builder +
      semantic patch + automated-releases status read/monitor. Beta/internal endpoints quarantined
      (`LD-API-Version: beta`, single `automatedReleasesPath()` to change when public)
- [x] Config schemas/loaders: `scopes.yaml`, `release-source.yaml` (`config.ts`); LD conns from env (`env.ts`)
- [x] Shared types (`types.ts`): `Scope`, `ReleaseKind`, `Stage`, `MetricRef`, `ReleaseOverrides`,
      `ReleaseFlagFile`/`DiscoveredFlag`, `ApprovalMode`, `RiskLevel`, `DeployNotification`
- [x] **Vega client interface** (`vegaClient.ts`): stable `VegaTransport` seam + `VegaClient` poll loop;
      `StubVegaTransport` throws until real API docs land (PLACEHOLDER, isolated)
- [~] Unit tests: release-instruction builder + scope matrix done (`tests/logic.test.ts`). Mocked-HTTP
      client tests + config-loader tests still pending.

---

## M3 — Config bridge (`packages/config-bridge/`)

- [x] `provision` command — idempotent (GET-then-create, backfills missing variations); reads
      `config/agentcontrol/{ai-configs,graphs}` (overridable). CLI verified end-to-end.
- [x] `sync` command — pull tag-filtered AI-configs + named graphs from the source instance into an
      output dir (deliberately not the public `config/agentcontrol/` — see ISSUES I3)
- [x] Agent-graph CRUD (`createAgentGraph`/`getAgentGraph`) — resolves the §S build-time question
- [~] Tools/snippets: bridge **strips tools** and reports them; full tool/snippet provisioning is
      deferred (we hold references, not definitions) → **ISSUES I4**
- [ ] Canonical starting configs + graphs committed under `config/agentcontrol/` (sanitized) →
      **ISSUES I3** (needs human sanitization review before public commit)
- [ ] Dry-run mode (print planned changes without writing) — not yet
- [ ] Tests against a mocked API — not yet (tracked with M2 tests)

---

## M4 — Bootstrap / easy-setup (`bootstrap/`)

- [x] `bootstrap/create.mjs` (`npm run bootstrap`): build → preflight → provision → print next steps.
      **Verified live** (reaches/authorizes against the target project)
- [x] `bootstrap/checks/preflight.mjs`: Node version, LD env present, LD API reachable+authorized,
      Phase 2 secrets noted — fails loudly
- [x] `bootstrap/github-action-template/auto-factory.yml`: drop-in PR workflow (PR-open trigger)
- [x] Uses the **real `config/` files** the partner edits (no hidden magic); provision is a no-op until
      canonical configs are added (ISSUES I3)
- [x] README Quickstart (install → bootstrap → drop in workflow → open a PR)

---

## M5 — Demo app (`examples/demo-app/`)

- [x] `frontend/` — Node/Express app, page + `/api/status`, fetches the backend greeting (syntax-checked)
- [x] `backend/` — Python/Flask, `/api/status` + `/api/greeting` gated by the `new-greeting` flag
      (graceful without LD SDK key); `requirements.txt` + `Procfile` (syntax-checked)
- [x] Each service exposes `/api/status` → `{service, version=deployed SHA}` (fullstack contract)
- [x] `.release-flags/pr-1.json` demonstrates the convention (backend scope, guarded rollout overrides)
- [~] Both deploy as independent Railway services + Notifier post-deploy — code/config ready; actual
      deploy is environment-specific → **ISSUES I7**
- [ ] Seed the demo flags/metrics (`new-greeting`, `api-errors`) in the target project — not yet

---

## M6 — Phase 1: resource creation (GitHub Action → Vega)

Depends on §S (Vega API). The chain is **5 sequential agents**:
research → flagging → **metrics** → testing → review. The reference build ships only four
(metrics is not yet a separate config), so the **metrics agent is authored new** — it is a core node,
not an optional enhancement.

- [x] Assemble PR context (`prContext.ts`) from the GitHub event payload + env
- [x] Dispatch to Vega via `VegaClient` (async dispatch + poll); transport is the stub until I1
- [x] **Trigger on PR opened/synchronized/reopened** — no label gate (workflow template in
      `bootstrap/github-action-template/auto-factory.yml`)
- [x] Walk the agent graph (`graphWalker.ts`): follows edges, honors handoff `skip_if_tags` /
      `require_tags`, threads each node's output. **Unit-tested** (3 cases incl. triage short-circuit)
- [x] **Approval logic** (`approval.ts`): yolo (auto-apply) / manual (human) / middle (gate on risk);
      default yolo; mode via env fallback (LD-flag read = ISSUES I6); verdict/risk read from tags (I9)
- [x] `action.yml` + `esbuild` bundle (`npm run bundle`) → node20 GitHub action
- [~] `adapters/ci-github/`: action prints a run summary; **posting the PR comment not yet wired**
- [—] `adapters/ld/` idempotent flag+metric: in this design the **agents create flags/metrics via Vega
      tools**, not the action; `LdClient` wrappers exist if a non-agent path is needed
- [ ] `agents/`: sanitized local copies of each agent's instructions → **ISSUES I3**
- [ ] **Author the metrics agent** (core 5th node) — needs the agent-authoring + sanitization pass
      (ISSUES I3); not built blind
- [ ] Code-delivery mechanism + CI-loop guard — **open** (depends on the source material; ISSUES carries it)
- [ ] **Package/publish the action** so `uses:` resolves: commit/publish the esbuild bundle → **ISSUES I10**
- [ ] End-to-end test on a real demo PR — **blocked on the real Vega transport (ISSUES I1)**

---

## M7 — Phase 2: automatic releases (Notifier + Beacon)

Concept-map of the reference: **Beacon calls the LD release API directly** instead of invoking a CD
pipeline system.

### Notifier (post-deploy)
- [x] `auto-factory-notify` — POSTs `{sha, previousSha, service, environment}` to Beacon; **non-blocking**
      (logs + exits 0 on error so it never delays deploys); shared-secret header
- [~] `previousSha` sourcing on Railway is an explicit input — how it's produced is open → **ISSUES I8**

### Beacon (`packages/beacon/`)
- [x] HTTP endpoint `POST /flag-releases` with shared-secret auth (`x-beacon-secret`); `GET /health`
- [x] **Discovery**: diff `.release-flags/` at `previousSha` vs `sha` via GitHub Contents API → new files
- [x] Parse `.release-flags/*.json` → `{flagKey, scope, releaseOverrides}`
- [x] **Scope routing** (generalized via `config/services.yaml` side mapping — not hardcoded service names):
      single-side → trigger, other-side → skip, fullstack → cross-service check
- [x] **Fullstack coordination** (stateless): reads the other side's deployed SHA from its status
      endpoint, verifies the `.release-flags/` file is present there; trigger if yes, wait if no
- [x] **Release trigger** → shared release adapter: immediate (targeting flip) vs. guarded/progressive
      `startAutomatedRelease`; resolves boolean flag variation IDs; metrics + monitoring prefs;
      `.release-flags` overrides applied
- [~] **Monitor**: `monitorRelease` exists in the adapter; Beacon currently fires-and-returns (doesn't
      block on monitoring). Wire-in deferred.
- [ ] **Backstop** for the fullstack "wait" path (retry/timeout) — not yet (relies on re-notification)
- [~] `release-source` is config-driven (`release-flags-dir` active); LD-native source is future
- [x] Tests: scope routing matrix + release-instruction builder (`tests/logic.test.ts`, 6 passing).
      Discovery/fullstack tests (need GitHub mock) — not yet.
- [~] **Multivariate flags**: trigger handles boolean only; non-boolean errors clearly → revisit later

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
