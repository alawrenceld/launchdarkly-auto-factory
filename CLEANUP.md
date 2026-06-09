# CLEANUP.md — Project cleanup & refactoring punch list

Findings from a full-repo review (2026-06-09), focused on making this a plug-and-play,
customer-facing prototype. Each item is self-contained so an agent can work through them
independently. Items are grouped by priority; within a group, order is suggested but not required.

> ## Progress (2026-06-09)
> **Done:** #1–#7, #9–#24, #26–#35, #37 (34 items). **Partial:** #25 (testability half done; the
> `loadPhase1Config` centralization deferred). **Deferred — needs owner input:** #8 (release-flags
> hand-off: both approaches need a decision). **Skipped (intentional):** #36 (cosmetic, build-risk).
>
> **Gate status:** `npm test` (68 pass), `npm run typecheck`, `npm run check:public` all green; the
> action bundle is rebuilt. Tests are now typechecked (#2). One pre-existing public-leak in the
> CHANGELOG was fixed in passing. Each item below carries a `✅/⏸️/⏭️` note with specifics.
>
> **Untested-against-live caveats to verify before relying on them:** #4 (`bridge seed` — no
> LD_SOURCE_* creds here) and #25's git threading (no live PR/remote here). #24's edge-`capabilities`
> + #28's `prompt_template` removal also touch the live LD graph, which still differs from the
> committed copy (the fallbacks make this harmless).

**Ground rules for whoever works this list:**
- This repo is PUBLIC. Run `npm run check:public` after every change. Never reference
  internal LaunchDarkly instance/tool names.
- After any source change under `packages/phase1-resource-factory/` or `packages/shared/`,
  rebuild the action bundle: `npm run bundle -w @auto-factory/phase1-resource-factory` and
  commit `dist/action.bundle.js` (CI fails on drift — see `.github/workflows/ci.yml:28-33`).
- `docs/build-checklist.md`, `docs/ISSUES.md`, `docs/demo-punchlist.md`,
  `docs/demo-pipeline-runbook.md` are **gitignored / local-only**. Do not un-ignore them
  without the owner's say-so.

---

## P0 — Broken right now

> **Status (2026-06-09):** all three P0 items DONE. `npm test` → 35 pass, `npm run typecheck`
> green (now includes `tests/`), `npm run check:public` green.
> **Also fixed in passing:** `config/agentcontrol/CHANGELOG.md` was leaking a blocked
> internal codename in 6 places — `check:public` was exiting 1 before any of this work.
> Genericized to "internal-monorepo" / `@internal/…` so the public check passes.

### 1. ✅ DONE — `tests/walker.test.ts` is broken — the test suite is red (3 failures)
Rewritten against the AI-SDK `AgentGraphDefinition` surface using the real
`AgentGraphDefinition.buildNodes(...)` + a `FakeRunner implements AgentRunner`
(scripted `{status, tags}` per configKey). Same three scenarios retained.
- **File:** `tests/walker.test.ts`
- **Symptom:** `npm test` → 3 failures: `TypeError: graphDef.rootNode is not a function`.
- **Cause:** the test was written against the old `walkGraph(graph, vegaClient, ctx)` signature.
  `walkGraph` (`packages/phase1-resource-factory/src/graphWalker.ts:101`) now takes
  `(graphDef: AgentGraphDefinition, runner: AgentRunner, context, graphTracker?)` — an AI-SDK
  `AgentGraphDefinition` (with `.rootNode()`, `.getNode()`, node `.getConfig()/.getEdges()`),
  not a plain `{key, rootConfigKey, edges}` object. The test also imports `type AgentGraph`
  from `@auto-factory/phase1-resource-factory`, which is no longer exported (it's a type-only
  import so it doesn't crash, but it's dead).
- **Fix:** rewrite the test with (a) a fake `AgentRunner` (replaces the `FakeTransport`/`VegaClient`
  plumbing — much simpler now: `runNode` returns scripted `{status, messages, tags}` per configKey),
  and (b) a small in-test fabrication of the `AgentGraphDefinition` surface the walker uses
  (`rootNode()`, `getNode(key)`, `getConfig()` returning `{root, edges}`, per-node `getKey()`,
  `getConfig()` (instructions/model/createTracker), `getEdges()`). Keep the same three scenarios:
  full chain, `skip_if_tags` short-circuit, unmet `require_tags`.

### 2. ✅ DONE — Tests are not typechecked, which is how #1 slipped through
Added `tests/tsconfig.json` (extends base, `noEmit`, `composite:false`); root
`typecheck` is now `tsc --build --pretty && tsc -p tests --noEmit`.
- **Files:** `tsconfig.json` (root — only references `packages/*`), `package.json:18` (test script
  runs via `tsx`, which strips types without checking them).
- **Fix:** add a `tests/tsconfig.json` (extends `tsconfig.base.json`, `noEmit: true`, references the
  packages) and include it in the root `typecheck` script, e.g.
  `"typecheck": "tsc --build --pretty && tsc -p tests --noEmit"`. This makes signature drift in
  `tests/` a CI failure instead of a runtime surprise.

### 3. ✅ DONE — `approval.ts` has zero test coverage despite being the most recently fixed logic
Added `tests/approval.test.ts`: `decideApproval` across all 3 modes × approved/rejected ×
risk low/high/undefined; `interpretWalk` for every accepted decision key + value form + risk
parsing; `getApprovalMode` default/normalization/fallback (restores `APPROVAL_MODE` after each).
- **Files:** `packages/phase1-resource-factory/src/approval.ts` (all three functions);
  the latest commit on this branch ("honor the reviewer's review_approved tag") changed
  `interpretWalk` with no test.
- **Fix:** add `tests/approval.test.ts` covering: `decideApproval` for all 3 modes ×
  approved/rejected × risk low/high/undefined; `interpretWalk` for each accepted tag key
  (`review_approved`, `review_decision`, `decision`, `approved`) and value form
  (`approve`/`approved`/`true`), plus risk parsing; `getApprovalMode` defaulting/normalization.

---

## P1 — Plug-and-play blockers (a design partner cannot succeed today)

### 4. ✅ DONE (code) — Agent configs can't reach a customer — add a seed-from-LaunchDarkly path
Added `bridge seed` (`packages/config-bridge/src/seed.ts` + CLI command): pulls the
graph(s) from LD_SOURCE_* into a gitignored `.agentcontrol-cache/`, reads the graph's
referenced config keys (root + edge source/target), pulls **exactly those** AI configs
(extended `sync` with a `configKeys` option), then provisions the staged copies into the
target project. `bootstrap/create.mjs` runs `seed` when LD_SOURCE_* is set, else falls back
to local-dir `provision`. `.agentcontrol-cache/` is gitignored.
> ⚠️ **Untested against live LaunchDarkly** — no LD_SOURCE_* creds available in this
> session, and the source is the internal prototype project. The sync→provision shape
> compatibility was verified structurally against a reference AI-config GET response
> (`variations[]` with instructions/model/modelConfigKey → `provision`'s VAR_FIELDS) and
> the committed graph shape. The CLI guards (clear error when source unconfigured, usage
> line) were smoke-tested. **Someone with prototype-project read creds should run
> `bridge seed --dry-run` once to confirm the live API responses match.**

#### Original notes
### 4-orig. Agent configs can't reach a customer — add a seed-from-LaunchDarkly path
- **Files:** `config/agentcontrol/ai-configs/` (empty by design — see below);
  `bootstrap/create.mjs:36-38` provisions from it; `packages/config-bridge/src/cli.ts`
  (`sync` and `provision` exist as separate commands but nothing chains them);
  `.env.example:26-31` (LD_SOURCE_* vars already document this intent).
- **Decision (owner, 2026-06-09):** the five `autofactory-*` configs are still in flight and will
  **NOT be committed** to the repo. The source of truth stays the LaunchDarkly
  `auto-factory-prototype` project. Plug-and-play instead means: pull the latest configs + graph
  from that project at setup time and provision them straight into the customer's project.
- **Why it matters:** today a partner who runs `npm run bootstrap` gets the graph
  (`graphs/auto-factory.json`) but none of the five AI configs it references — the pipeline
  cannot run. The two halves of the fix already exist in the bridge; they just aren't connected.
- **Fix:** add a `seed` command to the bridge CLI (`bridge seed` = `sync` from LD_SOURCE_* into a
  gitignored staging dir, e.g. `.agentcontrol-cache/`, then `provision` from that dir into the
  target project — no commit step). Then:
  - `bootstrap/create.mjs`: when LD_SOURCE_* is configured, run `seed` instead of the local-dir
    `provision`; fall back to local-dir provision otherwise (keeps the eventual committed-configs
    path working).
  - Make sure `seed` pulls the **graph** from source too (sync already supports `--graphs`), so a
    customer gets the current graph shape, not the possibly-stale committed
    `graphs/auto-factory.json`.
  - Credentials: `LD_SOURCE_API_KEY` can live in the customer's `.env` locally or as a GitHub
    secret for CI-run seeding. It must be a **read-only token scoped to the
    auto-factory-prototype project only** — a secret distributed to customers is effectively
    semi-public.
  - Sanitization note: `check-public` only guards committed files; runtime-pulled configs bypass
    it. The prototype LD project itself becomes the sanitization boundary — keep internal
    names/tools out of the live config instructions there.
  - Update the stale "provision is a no-op pending sanitization" messaging (see #12, #16) to
    describe the seed flow instead.

### 5. ✅ DONE — `.env.example` is missing `ANTHROPIC_API_KEY` — the DEFAULT provider's key
Added `ANTHROPIC_API_KEY` (with the "default provider" comment) plus a "Phase 1 behavior
toggles" block documenting `ENABLE_FLAG_CREATION`, `ENABLE_CODE_CHANGES`, `APPROVAL_MODE`,
`GRAPH_KEY`, `SANDBOX_ROOT`, `VEGA_REQUEST_TYPE`, and `LD_PIPELINE_CONTEXT_KEY`.
- **File:** `.env.example`
- **Why it matters:** the `auto-factory-ai-provider` flag defaults to `anthropic`
  (`packages/shared/src/providerFlag.ts:14`), and `AnthropicAgentRunner` needs
  `ANTHROPIC_API_KEY` (`packages/phase1-resource-factory/src/action.ts:82`). The file documents
  the optional Vega path in detail but omits the key the default path requires.
- **Fix:** add an `ANTHROPIC_API_KEY=` entry with a comment ("required when the
  auto-factory-ai-provider flag serves 'anthropic' — the default"). While there, also document
  the Phase 1 toggles read from env: `ENABLE_FLAG_CREATION`, `ENABLE_CODE_CHANGES`,
  `APPROVAL_MODE`, `GRAPH_KEY`, `SANDBOX_ROOT`, `VEGA_REQUEST_TYPE`, and
  `LD_PIPELINE_CONTEXT_KEY` (read at `packages/shared/src/ldSdk.ts:64`).

### 6. ✅ DONE — `action.yml` and `mapActionInputs` are out of sync
Declared `ld_project_key` and `vega_request_type` inputs in `action.yml`, and added the
`VEGA_REQUEST_TYPE` ← `vega_request_type` mapping in `mapActionInputs`. Bundle rebuilt.
- **Files:** `packages/phase1-resource-factory/action.yml` (inputs list),
  `packages/phase1-resource-factory/src/action.ts:122-146` (`mapActionInputs`).
- **Mismatches:**
  - `ld_project_key` is mapped in code (`action.ts:132`) but **not declared** in `action.yml`.
    Undeclared `with:` inputs generate workflow warnings and aren't a documented contract.
  - `VEGA_REQUEST_TYPE` is read by the action (`action.ts:46`) but has no `action.yml` input and
    no `mapActionInputs` entry — it only works as a raw env var.
- **Fix:** declare `ld_project_key` (and optionally `vega_request_type`) in `action.yml` inputs,
  or remove the orphaned mapping. Keep `action.yml`, `mapActionInputs`, and `.env.example`
  as one consistent contract.

### 7. ✅ DONE — Preflight doesn't check the keys Phase 1 actually needs
`bootstrap/checks/preflight.mjs` now checks `LD_SDK_KEY` (issue if missing) and
`ANTHROPIC_API_KEY` (note if missing, since the provider flag could serve vega). Did NOT add
the optional live SDK-init verification (kept the check fast/dependency-light).
- **File:** `bootstrap/checks/preflight.mjs`
- **Issue:** preflight validates Node version + `LD_API_KEY`/`LD_PROJECT_KEY` reachability, but
  never checks `LD_SDK_KEY` (hard-required at runtime, `packages/shared/src/ldSdk.ts:34`) or
  `ANTHROPIC_API_KEY` (required on the default provider path). A partner passes preflight and
  then fails on their first PR.
- **Fix:** add checks: `LD_SDK_KEY` present (issue if missing); `ANTHROPIC_API_KEY` present
  (note/warning, since the provider flag could serve `vega`). Optionally verify the SDK key by
  initializing the server SDK with a short timeout.

### 8. ⏸️ DEFERRED (needs an owner decision) — Phase 1 never writes the `.release-flags/` file that Phase 2 consumes
Both offered approaches carry friction I can't resolve confidently without the owner:
- **(a) instruction-based** (flag-implementer writes the file via its existing `write_file` +
  `commit_and_push`): the agent instructions are the live LD config, **not in this repo** (per #4 the
  configs aren't committed). Implementing it means editing the live `auto-factory-prototype` config —
  an external change, out of scope for a repo cleanup, and unverifiable from here.
- **(b) action writes it deterministically** after a successful walk: cleaner in principle, but the
  action (`action.ts`) currently does **no git** — the agents own commit/push via sandbox tools. To
  make the file actually reach Phase 2 it must be committed+pushed to the PR branch, so (b) means
  adding a git commit/push path to the action itself (new capability, untestable here, and it would
  race/duplicate the agents' own pushes).
Recommendation to surface: (b) keyed by **flag key** (`.release-flags/<flag-key>.json`, per plan §8),
writing `{flagKey, scope?}` derived from the walk's `flag_key`/`flag_created` tags, with the action
reusing the same git path the sandbox `commit_and_push` uses — but confirm with the owner whether the
action should gain git capability before building it. Docs (plan.html, GUIDE) still describe the file
as landing; left as-is pending the approach decision.
- **Files:** `docs/plan.html` (Phase 1 diagram: "+ `.release-flags/<id>.json` written");
  `examples/demo-app/GUIDE.md:25` ("A `.release-flags/pr-N.json` lands"); the agent tooling
  (`packages/shared/src/anthropic/sandboxTools.ts`) and the CHANGELOG show no agent/tool/
  instruction responsible for creating it. `examples/demo-app/.release-flags/pr-1.json` is hand-authored.
- **Why it matters:** this is the hand-off between Phase 1 and Phase 2. Today it's a silent manual
  step — the "fully autonomous" loop has a hole.
- **Fix (pick one, document the choice):** (a) add writing `.release-flags/<flag-key>.json` to the
  flag-implementer's instructions (it already has `write_file` + `commit_and_push`), or (b) have the
  action itself write the file deterministically after a successful walk (more reliable than an
  instruction; fits "idempotent glue code"). Then fix the docs to match. Note plan §8 already
  recommends keying by **flag key, not PR number** — do that here rather than `pr-N.json`.

### 9. ✅ DONE — Public files reference gitignored docs (broken links for partners)
Replaced every reference to gitignored docs with inline substance: `README.md` (links → plan.html
+ adr/; Status/Quickstart rewritten with #12), `approval.ts` (I9/I6 → inline tag/flag notes),
`config-bridge/{cli,provision,sync}.ts` (I3/I4 → inline tool-strip + sanitization notes),
`beacon/trigger.ts` (I5 was RESOLVED — corrected the stale "deferred" comment),
`beacon/notify.ts` (I8 → inline previousSha-diff explanation, verified against discovery.ts),
`GUIDE.md` (I7 → inline; see #22), `plan.html` (lines 94/491 → README + adr/). `grep` for
ISSUES/build-checklist/demo-punchlist in tracked non-dist files now returns nothing.
- **Occurrences:**
  - `README.md:14-15` → `docs/build-checklist.md`, `docs/ISSUES.md`; `README.md:26` → `docs/ISSUES.md`
  - `docs/plan.html` "What this document is" callout (~line 94) and footer (~line 489) → both
  - `bootstrap/create.mjs:48-49` → "see docs/ISSUES.md I3"
  - `packages/config-bridge/src/cli.ts:12,62` → "docs/ISSUES.md I3"
  - `packages/config-bridge/src/provision.ts:9` → "ISSUES.md I4"; `cli.ts:39` → "ISSUES I4"
  - `packages/beacon/src/trigger.ts:6,21` → "ISSUES I5"; `packages/beacon/src/notify.ts:13,28` → "ISSUES I8"
  - `examples/demo-app/GUIDE.md:39` → "docs/ISSUES.md I7"
  - `packages/phase1-resource-factory/src/approval.ts:7,21,50` → "ISSUES I9 / I6"
- **Fix:** these files ship to partners who don't have the local docs. Replace each reference with
  either (a) the substantive content inline (one sentence usually suffices), or (b) a public
  tracking location (GitHub issues). Don't just delete the pointers — the context they point to is
  often the only explanation of a deliberate gap.

---

## P2 — Documentation that no longer matches the code

### 10. ✅ DONE — `packages/phase1-resource-factory/README.md` describes a package that doesn't exist
Rewritten to the actual flat `src/` layout, the provider-seam architecture (default local Anthropic,
Vega alternative, links ADR 0005), handoff semantics, env-driven approval modes (flag planned), the
commit-the-bundle requirement, and the action.yml input contract.
- **Wrong now:**
  - Directory table (`github-action/`, `agents/`, `approval/`, `adapters/ci-github/`, `adapters/ld/`)
    — actual layout is flat: `src/{action,approval,comment,graphWalker,index,prContext}.ts` + `action.yml`.
  - "The agents themselves run on LaunchDarkly's hosted runtime — this package does not contain an
    agent loop" — false since the provider pivot: the **default** is the local Anthropic runner
    (`packages/shared/src/anthropic/anthropicAgentRunner.ts`); Vega is the alternative behind the
    `auto-factory-ai-provider` flag.
  - Graph description (`Research & Planning → Flagging → Metrics → Testing → Code Review`) doesn't
    name the real nodes/keys (`autofactory-research-planner` → `autofactory-flag-implementer` →
    `autofactory-metrics-author` → `autofactory-flag-testing` → `autofactory-code-reviewer`,
    per `config/agentcontrol/graphs/auto-factory.json`).
  - "Read the approval mode from a LaunchDarkly flag (per-repo)" — it's an env var /
    action input today (`approval.ts:24-27`, explicitly TODO).
- **Fix:** rewrite to document what's actually here: the action entrypoint (`action.ts`), the
  graph walker + handoff semantics (`require_tags` / `skip_if_tags` / `max_turns`), approval modes
  (env-driven, flag planned), PR comment posting, the `action.yml` input contract, and the
  commit-the-bundle requirement.

### 11. ✅ DONE — `packages/config-bridge/README.md` — wrong directories, wrong config location, resolved question
Rewritten around the flat `src/` layout and the real CLI (`provision` / `sync` / `seed`), points at
`config/agentcontrol/` as the canonical location and the LD_*/LD_SOURCE_* env contract (no YAML
connection file), states graph CRUD is REST (resolved), and documents idempotency + tool-stripping.
- **Wrong now:** the dir table (`configs/`, `provision/`, `sync/`) — actual layout is flat
  `src/{cli,provision,sync,index}.ts`; canonical copies live in **`config/agentcontrol/`**, not
  `packages/config-bridge/configs/`; "Build-time detail to confirm: Agent Graph CRUD may need the
  raw REST API" — resolved (graph CRUD is REST; the bridge does it in `provision.ts:126-156`).
- **Fix:** rewrite around the actual CLI: `bridge provision [--ai-configs <dir>] [--graphs <dir>] [--dry-run]`
  and `bridge sync --out <dir> [--tags ...] [--graphs ...]`, the LD_*/LD_SOURCE_* env contract,
  idempotency behavior, and the tools/snippets-stripping caveat.

### 12. ✅ DONE — Root `README.md` Status section is stale (and now inaccurate)
Rewrote Status (Phase 1 end-to-end on Anthropic; provider-flag architecture; dropped the test
count and the "two gates" framing; listed what's genuinely open: Vega entitlement, Phase 2 live
validation, approval-mode flag), fixed the Phase 1 bullet, and updated Quickstart to mention
`LD_SDK_KEY` + `ANTHROPIC_API_KEY`. Done with #9/#37.
- **Wrong now (`README.md:17-26`):**
  - "Two things gate a live end-to-end run: a reachable Vega dispatch endpoint and the canonical
    agent configs" — per the project owner, Phase 1 runs end-to-end today on the Anthropic
    provider against a live demo repo. Vega is optional, not a gate.
  - "23 unit tests … all green" — the suite is currently red (see #1), and the count drifts; drop the number.
  - Phase 1 bullet (line 7) says "a graph of LaunchDarkly-hosted agents" — the default execution is
    local (Anthropic API) with LD-native config/graph resolution; LD-hosted (Vega) is the alternative.
- **Fix:** rewrite Status to reflect reality: Phase 1 works end-to-end (PR → agents → flag created →
  code wired → tests → review → approval); name the provider-flag architecture; list what's still
  genuinely open (Vega entitlement, Phase 2 live deploy validation, approval-mode flag). Update the
  Quickstart to mention `LD_SDK_KEY` + `ANTHROPIC_API_KEY` (it currently says only "LD_API_KEY,
  LD_PROJECT_KEY, …").

### 13. ✅ DONE — `docs/plan.html` architecture callouts contradict the build
Added a dated (2026-06-09) "What changed in the build" callout right after the §2 Vega callout
(preserved the original, per the instruction not to rewrite history), rewrote the footer to
describe the provider seam + seed flow, and bumped "last updated" to 2026-06-09. The diagram
markup itself wasn't restructured — the callout + footer carry the correction.
- **Wrong now:** §2 "Agent runtime: Vega" callout says "**No agent loop ships in this repo**" and the
  Phase 1 diagram shows Vega as the only execution path; the footer says "Phase 1 agent execution
  awaits a reachable live Vega endpoint; canonical agent configs await a sanitization review".
- **Fix:** plan.html is the design-rationale document, so don't rewrite history — add a clearly-dated
  "What changed in the build" note (callout near §2 + updated footer): the runtime pivoted to a
  provider seam (`AgentRunner`), default = local Anthropic execution with LD-native AI-config/graph
  resolution; an agent loop *does* ship in `packages/shared/src/anthropic/`. Update the
  "last updated" date.

### 14. ✅ DONE — Missing ADR for the biggest architectural decision in the repo
Wrote `docs/adr/0005-provider-seam-local-anthropic-execution.md` (context/decision/consequences as
specified) and added the "superseded in part by ADR 0005" note to ADR 0004's status. Also fixed
two stale ISSUES refs found in the (public) ADRs: 0004's "ISSUES I1" and 0002's "ISSUES I5".
- **Files:** `docs/adr/` (0001–0004). ADR 0004 still describes Vega-behind-a-stub as the execution
  story.
- **Fix:** add `docs/adr/0005-provider-seam-local-anthropic-execution.md`: context (Vega dispatch
  blocked on entitlement; agents needed to run for real), decision (provider-agnostic `AgentRunner`
  seam; `auto-factory-ai-provider` LD flag selects backend; default local Anthropic tool-use loop
  with capability-gated sandbox tools; LD AI SDK still resolves configs/graphs/tracking natively),
  consequences (agent loop now ships in-repo; Vega path preserved unchanged). Add a one-line
  "Superseded in part by ADR 0005" note to ADR 0004's status.

### 15. ✅ DONE — `packages/beacon/README.md` directory table doesn't match the code
Rewrote the table for the real flat `src/` files, removed the (nonexistent) Railway adapter and
stated Beacon calls the LD release API directly (ADR 0002), and documented the HTTP contract
(`POST /flag-releases` + `x-beacon-secret`, `GET /health`), the `auto-factory-notify` bin, and the
`config/*.yaml` + env config surface.
- **Wrong now:** table lists `notifier/`, `discovery/`, `scope/`, `coordination/`,
  `adapters/cd-railway/` — actual layout is flat `src/{server,notify,discovery,scope,fullstack,github,trigger,config,index}.ts`.
  There is **no Railway adapter at all** — Beacon calls the LaunchDarkly release API directly
  (that's ADR 0002, and it's the better description).
- **Fix:** rewrite the table for the real files; document the HTTP contract (`POST /flag-releases`
  with `x-beacon-secret`, `GET /health`), the `auto-factory-notify` bin, and the config surface
  (`config/services.yaml`, `config/scopes.yaml`, `config/release-source.yaml`, env).

### 16. ✅ DONE — `bootstrap/create.mjs` prints stale next-steps
Secrets/vars list now matches the workflow template (`LD_SDK_KEY`, `ANTHROPIC_API_KEY`,
`LD_API_KEY` secrets; `LD_APP_PROJECT_KEY` variable; GITHUB_TOKEN noted as auto-provided).
The no-op caveat is replaced by a description of the seed flow (and how to enable it via
LD_SOURCE_*). Done together with #4.
- **File:** `bootstrap/create.mjs:41-50`
- **Wrong now:** "Add repo secrets: LD_API_KEY (+ GITHUB_TOKEN and BEACON_WEBHOOK_SECRET for
  Phase 2)" — the workflow template (`bootstrap/github-action-template/auto-factory.yml`) actually
  needs secrets `LD_SDK_KEY`, `ANTHROPIC_API_KEY`, `LD_API_KEY` and the repo **variable**
  `LD_APP_PROJECT_KEY`. The closing note ("provision is a no-op" pending sanitization) goes away
  once #4 lands.
- **Fix:** align the printed secrets/vars list with the template; replace the no-op caveat with a
  description of the seed-from-LaunchDarkly flow once #4 lands.

### 17. ✅ DONE — `packages/shared/README.md` undersells/misdescribes the package
Replaced with a one-line-per-file module map (AgentRunner seam, Anthropic runner + sandbox tools +
ldWriter, Vega client/transport, ldSdk bootstrap, providerFlag, releaseAdapter, env, config, types)
plus a "customization seams" section.
- **Wrong now:** describes only "types, LD API client, config schemas". The package now contains the
  heart of the prototype: the `AgentRunner` seam, the Anthropic runner + sandbox tools + LD writer,
  the Vega client/transport, the native SDK bootstrap (`ldSdk.ts`), the provider flag, and the
  release adapter.
- **Fix:** add a short module map (one line per file) so partners can find the customization seams.

### 18. ✅ DONE — `packages/shared/src/vegaClient.ts` header says PLACEHOLDER — it isn't anymore
Rewrote the header (transport seam; GraphQLVegaTransport real, StubVegaTransport = no-config
fallback), deleted the dead `endpoint`/`auth` fields from `VegaClientOptions` (verified `VegaClient`
never reads them — build passes), updated the stub's message, and dropped the two eslint-disable
comments. Bundle rebuilt.
- **File:** `packages/shared/src/vegaClient.ts:1-14, 50-56`
- **Wrong now:** "⚠️ PLACEHOLDER. The real public Vega dispatch endpoint, auth model, and
  payload/response shapes are pending" — `GraphQLVegaTransport` exists (`vegaTransport.ts`), the
  shapes are implemented, and auth was live-verified. Also `VegaClientOptions.endpoint` and
  `VegaClientOptions.auth` are **dead fields** — `VegaClient` never reads them (the transport owns
  endpoint/auth).
- **Fix:** rewrite the header ("transport seam; `GraphQLVegaTransport` is the real implementation,
  `StubVegaTransport` is the no-config fallback"), delete `endpoint`/`auth` from
  `VegaClientOptions`, and drop the two `eslint-disable` comments (the repo has no eslint config).

### 19. ✅ DONE — `setup-steps.md` is an abandoned scratch file at the repo root
Moved the Agent-Dispatch-entitlement note into the Vega section of `.env.example`; deleted the file.
- **File:** `setup-steps.md` (3 lines, ends with a dangling "- ").
- **Fix:** move its one real fact ("the Agent Dispatch API must be enabled via a LaunchDarkly flag /
  entitlement for the project before Vega dispatch works") into the Vega section of `.env.example`
  or the root README's Vega notes, then delete the file.

### 20. ✅ DONE — `config/ld-targets.yaml` is decorative — nothing reads it
Chose (a): deleted the file (confirmed no code reads it — only docs referenced it) and fixed the
plan.html directory tree to drop it and list the real config files. Connection surface is `.env`.
- **File:** `config/ld-targets.yaml`; referenced as the config surface by
  `packages/config-bridge/README.md:13-14` and `docs/plan.html` §3.
- **Issue:** the `${LD_BASE_URL}`-style placeholders are never interpolated; source/target
  connections come entirely from env (`packages/shared/src/env.ts`). A partner editing this file
  changes nothing — the worst kind of customization point.
- **Fix (pick one):** (a) delete it and point docs at `.env.example` as the single connection
  surface, or (b) make `env.ts` actually read it as defaults-under-env. (a) is less code and
  honest; recommended for a prototype.

### 21. ✅ DONE — `sources/` scaffolding promises tooling that doesn't exist
Chose (b): kept the manifest (harmless intent doc) but removed every reference to nonexistent
scripts. `manifest.yaml` now says "vendored manually (no sync script)" and that LD configs aren't
vendored (bridge sync/seed instead); plan.html §3 `scripts/` line and §4 table rows updated to drop
`scripts/sync-sources` / `scripts/sanitize` and describe the bridge-based flow.
- **Files:** `sources/manifest.yaml` (all entries commented out), `sources/ld-configs/.gitkeep`;
  `docs/plan.html` §3/§4 references `scripts/sync-sources` and `scripts/sanitize` — `scripts/`
  contains only `check-public.mjs`.
- **Fix:** either remove the `sources/` tree + manifest and the plan's references (nothing vendored
  in practice; the bridge's `sync` covers LD configs), or keep the manifest but fix plan.html to say
  syncing is manual. Don't ship references to scripts that don't exist.

### 22. ✅ DONE — `examples/demo-app/GUIDE.md` vs. the real demo setup
Added a "What this is" note (in-repo copy = reference/starting point; the action targets whatever
repo installs the workflow), noted that agents derive flag keys per-PR (not always `new-greeting`)
and keyed the release-flag file by `<flag-key>`, and inlined the I7 content (done with #9).
- **File:** `examples/demo-app/GUIDE.md`
- **Issues:** (a) it implies this in-repo copy is *the* demo, while the working Phase 1 demo runs
  against a separate app repo wired with the workflow template — clarify the relationship
  (in-repo copy = reference/starting point; the action targets whatever repo installs the
  workflow); (b) the flag is named `new-greeting` here but agents derive flag keys per-PR — note
  that; (c) `docs/ISSUES.md` reference (covered by #9).

### 23. ✅ DONE (with a caveat) — `.gitignore` has an unexplained ignore of `examples/demo-app/README.md`
Moved the rule out of the Editor/OS block and added a comment explaining the likely reason:
examples/demo-app is the default agent `SANDBOX_ROOT`, so with `ENABLE_CODE_CHANGES` agents may
write/modify a README there during local runs, and the ignore keeps that churn uncommitted.
> ⚠️ **Inferred, not confirmed.** The committed file is clean/human-looking and GUIDE.md (same dir)
> IS tracked, so the asymmetry is a little odd. If the real reason differs, adjust the comment or
> just delete the rule.
- **File:** `.gitignore:35` (sitting under the "Editor / OS" section, with no comment).
- **Fix:** if agents generate a README there during runs, say so in a comment and move it out of the
  Editor/OS block; otherwise delete the rule. Unexplained ignores of normal-looking files confuse
  contributors.

---

## P3 — Code refactors worth doing (prototype-appropriate, not gold-plating)

### 24. ✅ DONE — `NODE_CAPABILITIES` hardcodes agent config keys in the runner
Capability grants now live on the graph edge `handoff.capabilities` array
(`["create_flag", "edit_files"]` on the flag-implementer edge, `["edit_files"]` on the flag-testing
edge). Flow: walker extracts `capabilities` from the inbound handoff → `AgentNodeRequest.capabilities`
→ `resolveGrant()` in the runner uses it (source "edge"), else falls back to `NODE_CAPABILITIES` by
key (source "fallback"), else read-only (source "none"). A per-node log line prints the grant + source
so a renamed agent that silently lost its grant is visible. Always intersected with global
ENABLE_* toggles. Unit-tested in `tests/resolveGrant.test.ts`; documented in agentcontrol README +
CHANGELOG. Bundle rebuilt.
- **File:** `packages/shared/src/anthropic/anthropicAgentRunner.ts:64-67`
- **Issue:** write capabilities are granted by exact config key
  (`autofactory-flag-implementer`, `autofactory-flag-testing`). A partner who renames or adds an
  agent silently gets a read-only node and a stalled pipeline — invisible coupling that
  contradicts the "agent steps are config, not code" principle.
- **Fix:** move capability grants into config — the natural seam is the graph edge `handoff`
  object (it already carries `max_turns`/`request_type`; add e.g. `"capabilities": ["create_flag",
  "edit_files"]` on the inbound edge, plus a root-node default in the graph file), or a small map in
  `config/agentcontrol/`. Keep `NODE_CAPABILITIES` only as a fallback, and log when a node gets
  no grant so renames are diagnosable.

### 25. ✅ PARTIAL — Phase 1 env-var sprawl — centralize the runtime config
Did the testability-focused half: `prBranch`/`prBaseRef` are now passed explicitly into
`AnthropicAgentRunnerOptions` → `SandboxToolExecutor` (constructor params), so `resolveBaseRef`
(`git_diff`) and `commitAndPush` prefer the injected values and only fall back to `process.env`.
The sandbox tools no longer *depend* on env mutation to test.
> **Not done (deliberate):** the broader `loadPhase1Config()` centralization of action.ts's ~12 env
> reads + folding in `mapActionInputs`. That's readability churn on the **untested** action
> entrypoint (no unit harness, runs only in CI), where a missed var or changed default would
> regress silently and I can't run it here. Left as a follow-up to do with eyes on a live run.
- **Files:** `packages/phase1-resource-factory/src/action.ts` (reads ~12 env vars inline),
  `packages/shared/src/{env,ldSdk}.ts`, `packages/shared/src/anthropic/sandboxTools.ts:336,421`
  (reads `PR_BASE_REF` / `PR_BRANCH` directly from `process.env` deep inside tool code).
- **Issue:** the configuration surface is scattered, so "what knobs exist" requires reading five
  files; sandbox tools reaching into `process.env` makes them untestable without env mutation.
- **Fix:** introduce one `loadPhase1Config()` (in the action package) that maps inputs → a typed
  object, and pass `prBranch`/`prBaseRef` into `SandboxToolExecutor`/`AnthropicAgentRunnerOptions`
  explicitly. `mapActionInputs` folds into it. This is also what makes #6 stay fixed.

### 26. ✅ DONE — `postPrComment` posts a new comment on every run
Implemented the marker pattern: the body carries a hidden `<!-- auto-factory-phase1 -->` marker;
the function lists the PR's comments (per_page=100), and PATCHes the existing marked comment if
found, else POSTs. Best-effort/non-fatal behavior preserved. Bundle rebuilt.
- **File:** `packages/phase1-resource-factory/src/comment.ts`
- **Issue:** every `synchronize` (including the agents' own pushes — each agent commit re-triggers
  the workflow) appends another summary comment; busy PRs accumulate noise. Customer-facing polish.
- **Fix:** standard marker pattern — embed `<!-- auto-factory-phase1 -->` in the body, list the PR's
  comments, and PATCH the existing one if found, else POST.

### 27. ✅ DONE — Pin the agent tag contract; stop guessing in `interpretWalk`
Documented the canonical tags (`skip_flagging`, `flag_created`, `flag_key`, `needs_tests`,
`review_approved`, `risk_level`) in `config/agentcontrol/README.md`. `interpretWalk` now reads the
canonical keys FIRST — fixed a real ordering bug where legacy `risk` was read before canonical
`risk_level` — and the legacy fallbacks are kept behind `// legacy` comments. Covered by #3's tests.
- **Files:** `packages/phase1-resource-factory/src/approval.ts:50-67`;
  `packages/shared/src/anthropic/anthropicAgentRunner.ts:26-31` (TAGGING_NOTE);
  `config/agentcontrol/graphs/auto-factory.json` (edge conditions).
- **Issue:** the agent configs now reliably emit `review_approved` / `risk_level` (per the
  CHANGELOG and the recent fix), but `interpretWalk` still probes four legacy keys "best-effort".
  For a partner-facing contract, ambiguity is a liability.
- **Fix:** document the canonical tags in one place (the agentcontrol README is a good home:
  `skip_flagging`, `flag_created`, `flag_key`, `needs_tests`, `review_approved`, `risk_level`),
  make `interpretWalk` read the canonical keys first, and either delete the fallbacks or keep them
  behind a comment that names them as legacy. Pair with tests from #3.

### 28. ✅ DONE — `graphWalker` ignores `prompt_template` carried by every graph edge
Chose (b): documented the handoff fields the walker honors (`require_tags`, `skip_if_tags`,
`max_turns`, `request_type`) in `config/agentcontrol/README.md` and stripped the inert
`prompt_template` from the committed `graphs/auto-factory.json` (the walker owns prompt construction
for every provider, so it never reached Vega). Logged in the CHANGELOG; live LD graph may still
carry it (harmless).
- **Files:** `config/agentcontrol/graphs/auto-factory.json` (every edge has
  `"prompt_template": "{{PR_NUMBER}}"`); `packages/phase1-resource-factory/src/graphWalker.ts`
  (`buildPrompt` never reads it).
- **Issue:** the canonical graph advertises a templating capability the walker doesn't implement —
  a partner editing `prompt_template` would see no effect.
- **Fix (pick one):** implement it (interpolate `{{VAR}}` from the walk context into the node
  prompt, falling back to the current header+brief behavior), or strip `prompt_template` from the
  canonical graph JSON and note in `config/agentcontrol/README.md` which handoff fields the walker
  honors (`require_tags`, `skip_if_tags`, `max_turns`, `request_type`).

### 29. ✅ DONE — `safeResolve` sandbox check — tighten the no-op clause
Replaced the dead `resolve(abs) !== abs` clause with the idiomatic
`within === ".." || within.startsWith(".." + sep) || isAbsolute(within)`. Unit tests added in
`tests/sandboxTools.test.ts` (inside/descendant allowed, `../escape` rejected, absolute path rejected).
- **File:** `packages/shared/src/anthropic/sandboxTools.ts:192-199`
- **Issue:** `resolve(abs) !== abs` is always false (resolving an already-absolute path is identity)
  — dead guard. Escape protection rests solely on `within.startsWith("..")`, which works (including
  for absolute inputs) but is subtle, and `within.startsWith("..")` would also wrongly reject a file
  literally named `..foo` at the root (cosmetic).
- **Fix:** replace with the idiomatic check: `const within = relative(this.root, abs);` then reject if
  `within === ".." || within.startsWith(".." + sep) || isAbsolute(within)`. Add a couple of unit
  tests (inside, `../escape`, absolute path) — this is the security boundary for agent tool calls.

### 30. ✅ DONE — `anthropicModelId` mis-handles fully-qualified Bedrock-style ids
Now strips at most an optional region segment (`/^[a-z]{2}\./i`) then a single `anthropic.` prefix
(case-insensitive); multi-dot/versioned ids pass through unchanged. Exported and unit-tested per
shape in `tests/anthropicModelId.test.ts` (bare, prefixed, region+prefix, bare versioned, empty).
- **File:** `packages/shared/src/anthropic/anthropicAgentRunner.ts:173-177`
- **Issue:** the "strip provider prefix" rule (`split(".").slice(1)`) turns
  `us.anthropic.claude-sonnet-4-6-v1:0` into `anthropic.claude-sonnet-4-6-v1:0` — wrong for any
  multi-dot model name. Works today only because LD configs use `Anthropic.claude-…`.
- **Fix:** strip at most one known provider prefix (case-insensitive `anthropic.`), optionally after
  a region segment; otherwise pass through unchanged. One unit test per shape.

### 31. ✅ DONE (minimum viable) — Beacon's fullstack "waiting" path still has no backstop
Added an actionable `console.warn("[beacon] WAITING: …")` on the waiting branch (flag, scope, file,
service, sha + the manual re-trigger hint), and documented the manual re-POST runbook in the beacon
README. No retry queue (overkill for the prototype, per the item).
- **Files:** `packages/beacon/src/server.ts:65-71`, `packages/beacon/README.md` (open consideration).
- **Issue:** acknowledged in the plan (§8) and README, but as the prototype heads to partners, a
  lost notification silently strands a release with no retry/timeout and no visibility.
- **Fix (minimum viable):** log "waiting" outcomes with enough detail to act on, and document the
  manual re-trigger (re-POST the notification). A retry queue is overkill for the prototype; an
  honest runbook note is not.

### 32. ✅ DONE — Test gaps for the code that now does the real work
`tests/sandboxTools.test.ts` covers: read_file/list_dir/grep happy paths, unknown-tool handling,
sandbox escape rejection (pairs with #29), tag accumulation, capability gating (`buildSandboxTools`
+ executor refusals when allowEdits/writer absent), edit_file uniqueness error + success, and
create_flag fallback tagging (`flag_created`/`flag_key`) via a fake writer. `tests/ldWriter.test.ts`
covers key validation, 409→alreadyExists vs created, tag dedupe/merge, and the safe-default variation
shape (fake `LdClient`). `tests/vegaAgentRunner.test.ts` covers the field-for-field mapping +
maxTurns forwarding (fake transport). No network, no git.
- **Files:** no tests exist for `packages/shared/src/anthropic/*` (tool dispatch, capability gating,
  tag accumulation, `create_flag` fallback tagging at `sandboxTools.ts:301-304`), `ldWriter.ts`
  (409 → alreadyExists), or `vegaAgentRunner.ts`.
- **Fix:** add focused unit tests with a fake `LdClient`/`writer` and a temp-dir sandbox root:
  read_file/list_dir/grep happy paths, sandbox escape rejection (pairs with #29), edit_file
  uniqueness errors, tag_conversation accumulation, capability-gated tool availability
  (`buildSandboxTools` and executor refusals). No network, no git.

---

## P4 — Nits / consistency

### 33. ✅ DONE — Naming: "Auto-Factory" vs "AutoFactory" vs "auto-factory"
Documented the convention in `config/agentcontrol/README.md`: prose form **AutoFactory**; new keys
use `autofactory-` (AI configs) / `auto-factory-` (flags); existing live LD resources are not
renamed. (Did not mass-rename existing prose/keys, per the item.)
- README/plan/action.yml say "Auto-Factory"; CHANGELOG/agent configs/commit messages say
  "AutoFactory"; keys/flags use `auto-factory-*` and `autofactory-*` (`gha-auto-factory` graph but
  `autofactory-research-planner` configs). Pick one prose form (suggest **AutoFactory**) and one
  key prefix convention for *new* resources; don't rename existing LD resources (the configs/graph
  in LD are live) — just document the convention in `config/agentcontrol/README.md`.

### 34. ✅ DONE — `initial_instructions.md` at the repo root
`git mv` → `docs/initial-instructions.md`. No inbound links to fix (grep found none).
- Historical kickoff brief. Harmless, but for a partner-facing repo consider moving to
  `docs/initial-instructions.md` (and fix the one link in any doc that references it) so the root
  stays: README, CLEANUP, configs, code.

### 35. ✅ DONE — `.vscode/settings.json` is an empty `{}` (2 bytes), tracked
`git rm`'d the empty file and added `.vscode/` to `.gitignore`.
- Delete it (and add `.vscode/` to `.gitignore`) or put real recommended settings in it.

### 36. ⏭️ SKIPPED (intentional) — `packages/*/tsconfig.tsbuildinfo` clutter
Explicitly cosmetic ("Cosmetic only" in the item itself) and changing `tsBuildInfoFile` touches
incremental-build behavior across every package + the new `tests/` project for no functional gain.
The files are already gitignored (`*.tsbuildinfo`). Not worth the risk to the working build.
- Untracked (covered by `*.tsbuildinfo`) but sitting in package roots because `tsc -b` defaults
  there. Optional: set `"tsBuildInfoFile": "dist/.tsbuildinfo"` in `tsconfig.base.json` variants to
  keep build state out of source dirs. Cosmetic only.

### 37. ✅ DONE — README layout table omits `config/agentcontrol/` and the CHANGELOG convention
Layout table now lists `config/agentcontrol/`, fixes the stale `phase1`/`shared`/`config-bridge`
row descriptions, and a "Conventions" line documents the CHANGELOG-on-config-change agreement.
- `README.md` Layout lists `config/` generically. Given the CHANGELOG-on-config-change convention
  (`config/agentcontrol/CHANGELOG.md`) is a real working agreement, surface it: one line in the
  Layout table or a "Conventions" bullet ("changes to AI configs / the graph / operational flags
  are logged in config/agentcontrol/CHANGELOG.md").

---

## Suggested execution order

1. **P0 first** (#1–#3) — gets CI green and guards the rest of the work.
2. **#4 (seed-from-LD path)** — pure code now (no sanitization review needed since nothing is
   committed); a `seed` CLI command + bootstrap wiring.
3. **The contract triple (#5, #6, #7, #16)** — one PR: env/example, action.yml, preflight, bootstrap
   messages all aligned.
4. **Doc sweep (#9–#15, #17–#23)** — mostly mechanical once the architecture story (#14) is written;
   write ADR 0005 first and let the READMEs reference it.
5. **#8 (release-flags hand-off)** — small code change + doc fix; decide approach with the owner.
6. **P3 refactors** as time allows — #24, #27, #29 have the best value-to-effort for a partner-facing
   prototype.
