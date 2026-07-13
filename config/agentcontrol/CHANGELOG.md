# AutoFactory Agent Config & Graph — Change Log

Running log of changes to the AutoFactory **AI configs** (`autofactory-*`), the
**agent graph** (`gha-auto-factory`), and the **operational flags** that drive the
pipeline. These resources live in LaunchDarkly (the factory / control-plane project
`auto-factory-prototype`), not as files in this repo — this file is the
human-readable record of what changed there and why.

> Out of scope: agent *runtime* changes (the action's tools — `git_diff`,
> `create_flag`, `write_file`/`edit_file`/`run_tests`/`commit_and_push` — and the
> approval logic) live in the code repo / its PRs. They're referenced here only
> where they explain a config change.

Status legend: ✅ done · 🔜 planned/in progress

---

## 2026-07-13

### ✅ Frontend-scoped flags auto-expose to the client-side SDK (`create_flag`)
- **Runtime fix** (`ldWriter.createBooleanFlag`): when `scope` is `frontend` or
  `fullstack`, new flags include `clientSideAvailability.usingEnvironmentId`.
  On idempotent re-runs (HTTP 409), a semantic patch turns client-side
  availability on for existing flags.
- **`create_flag` tool** accepts optional `scope`; when omitted, reads
  `.release-flags/*.json` (sole manifest or matching `flagKey`).
- **Flag implementer** instructions: pass scope from the release manifest when
  calling `create_flag`.
- **Why:** flags could be targeting-on in LaunchDarkly but invisible to browser
  SDKs — UI gates silently stayed on their offline defaults.

### ✅ LLM-friendly LaunchDarkly docs for the agents (`read_ld_docs`)
- **New capability token** `read_docs` → **new tool** `read_ld_docs`: fetches
  LaunchDarkly documentation pages as clean markdown (the docs site serves
  `.md` for any page; validated that expand/accordion content is fully inlined
  — e.g. all 27 per-SDK "Expand … code sample" sections on
  `sdk/features/all-flags` survive). Allowlisted to launchdarkly.com/docs
  only, 25KB size cap, 8 fetches per node run, 10s timeout, fail-soft (a
  failed fetch tells the agent to proceed from repo evidence).
- **Granted to** flag-implementer, metrics-author (graph edges +
  fallback map) and code-reviewer (new edge capability + fallback entry).
  Research planner / steward / testing stay without — keep the chain lean.
- **Instructions** gained per-agent shortlists + `llms.txt` as the fallback
  directory: metrics-author (sdk/features/events, guarded-rollouts,
  custom-metrics, choose, create-trace-metrics), implementer
  (sdk/features/evaluating, all-flags), reviewer (evaluating, events,
  guarded-rollouts). Framing everywhere: consult when UNCERTAIN, never guess
  SDK syntax for an undemonstrated language, docs are an aid not a gate.
- **Why:** agents previously reasoned about LD semantics from baked-in
  instructions + repo patterns only; live docs close the gap for unfamiliar
  languages and rollout mechanics without fossilizing content in prompts.
- **Live sync:** requires `bridge upgrade` (instructions + graph edges).

## 2026-07-10

### ✅ Knowledge graph: `auto-factory-knowledge-graph` flag + `query_graph` capability (ADR 0010)
- **New operational flag** `auto-factory-knowledge-graph` (boolean, provisioned
  **off**): gates per-run composition of the knowledge graph (service edges
  derived from observability traces + flag wrap points from find-code-refs at
  the PR SHA) and the `query_dependencies` agent tool. Off = the judge-score
  A/B baseline; flag-off runs pay no composition cost.
- **New capability token** `query_graph` (`ToolCapabilities.queryGraph`),
  granted to the research planner via the ROOT fallback (root nodes can't
  receive edge grants). The tool is only offered when a graph was actually
  composed for the run — the flag is the global enable, the capability is the
  per-node grant, same two-level model as `create_flag`.
- **New tool** `query_dependencies`: no-arg call = the PR's blast radius
  (changed services, dependent services with depth+evidence, upstream contract
  services, flags already wrapping changed code); or walk
  dependents/dependencies of one service/flag/file node. Responses carry the
  artifact's `gaps` list and the mode note instructs agents to treat gaps as
  UNKNOWN coverage, never low risk.
- **Why:** ADR 0010 — impact analysis composed from LD-native sources instead
  of a third-party code-graph dependency.
- **Live sync:** with the ADR 0010 build (`bridge upgrade`), not yet pushed.

### ✅ Metrics author: trace-metric backing rules + telemetry-footprint duty (ADR 0010)
- **Instructions** (`autofactory-metrics-author`, default variation): new **Metric
  Backing** section — a guardrail metric must be per-unit attributable to a flag
  variation; exactly two valid backings: custom `track()` events (default) and
  **trace metrics** on span attributes. Trace metrics are valid ONLY when the flag
  is evaluated INSIDE the active span context: the observability SDK plugin's flag
  `afterEvaluation` hook enriches the active span (client-side: child span), so a
  trace metric can only be built on span attributes within a trace that evaluates
  this flag. **Pre-aggregated OTel metrics are never a valid guardrail backing.**
  `create_metric` remains event-only for now, so the agent records
  `trace_metric_candidates` (span attribute + filter) in its output instead of
  creating them; revisit when the trace-metric API is available (EAP).
- **New rule M10 (telemetry footprint):** when the service already uses the LD
  observability SDK, span-cover the flagged path with the flag evaluated in-span
  and add `<flag-key>.<attribute>` span attributes — growing the service telemetry
  AutoFactory's impact analysis reads. Never install the SDK into an
  uninstrumented service (platform decision; report `span_coverage: none`).
- **Chain output** gains `telemetry: { span_coverage, spans_added,
  trace_metric_candidates }`.
- **Why:** the knowledge-graph direction (ADR 0010) derives service-dependency
  edges from LD observability traces; each PR the factory processes should widen
  that footprint. Demo estate design: services get a one-time baseline
  instrumentation sweep, but future demo PRs intentionally ship uninstrumented so
  the metrics author demonstrably fills the gap.
- **Live sync:** not yet pushed to the live factory project — sync via
  `bridge upgrade` together with the ADR 0010 code build.

### ✅ Release intent + manifest steward node (ADR 0009)
- **New AI config** `autofactory-manifest-steward` (mode agent, Sonnet 4.6):
  normalizes human edits to the release manifest's `releaseIntent` block —
  promotes free-text notes ("child of flag-xyz") into structured fields via ONE
  `write_manifest` call, passes the brief through unchanged, fast no-op on an
  untouched skeleton, NEVER broadens intent (never hold→auto).
- **Graph `gha-auto-factory` rewired**: research → **steward** → implementer
  (was research → implementer). Edges: research→steward `{max_turns: 8,
  request_type: "Fix", capabilities: ["steward_manifest"], skip_if_tags:
  {skip_flagging: "true"}}`; steward→implementer carries the implementer's
  previous grant plus `write_manifest`; implementer→metrics adds `write_manifest`.
- **Instruction updates**: research planner gains "Release Manifest (create it
  now)" (creates the manifest + intent skeleton via `write_manifest`); flag
  implementer gains a manifest-correction section; metrics author's
  `releaseOverrides` renamed to **`releasePlan`** (legacy key still read/healed).
- **Registry/tags**: `skip_flagging` edge now research→steward (kind
  `skip_if_tags`).
- **Rollout note**: existing installs pick all of this up via the new
  **`bridge upgrade`** command (provision what's missing + sync existing
  variation instructions and graph edges to the committed defs; built-in
  no-op `modelConfigKey` re-PATCH after every instruction update, so the
  2026-07-08 cost-derivation workaround is automatic).
- **Config-version stamp**: provision/upgrade now append a `[cfg:<hash>]`
  marker to the `gha-auto-factory` graph **description** (hash of the
  committed ai-configs/graphs/flags). The GHA action compares it against its
  own checkout at chain start and warns on drift (Actions log + PR summary
  comment). UI instruction edits don't affect the stamp — it tracks which
  repo version last provisioned the project, not live content.

## 2026-07-08

### ✅ Approval policy: three flags compiled into pre-execution gates (ADR 0008)
- **New flags** (factory project + committed defs, provisioned by bootstrap):
  `auto-factory-approval-mode` (`yolo` default / `risk-threshold` / `always`) and
  `auto-factory-risk-threshold` (0–1, default 0.6). `auto-factory-approval-gates`
  reworked: **no empty variations** (implementer at minimum — yolo is the bypass);
  entries may be `{step, threshold}` objects for per-step sensitivity.
- **Research planner (default variation)** now emits a numeric **`risk_score`**
  (0.0–1.0, anchored: ~0.2 additive / ~0.5 business logic / ~0.8 cross-cutting,
  auth, payments, migrations) alongside `risk_level`; forced via
  NODE_REQUIRED_TAGS so risk-threshold gates fail closed when absent. Registry +
  README table gained `risk_score`; `risk_level` re-described as the categorical
  companion/fallback.
- **Post-hoc modes removed** from the runtime: `decideApproval` is verdict-only;
  the yolo/middle/manual env semantics are legacy-mapped (`middle`→risk-threshold,
  `manual`→always). Workflow templates no longer hardcode `approval_mode`.
- ⚠ The planner instruction edit is a variation PATCH — the no-op
  `modelConfigKey` re-PATCH (cost-derivation workaround, 2026-07-08) was applied
  in the same change.

## 2026-07-07

### ✅ Judges are now part of bootstrap (committed + provisioned)
- **Committed:** `ai-configs/autofactory-judge-implementation-quality.json` and
  `-metrics-quality.json` (mode `judge`, `evaluationMetricKey`, rubric v2 exported
  from live), plus `judgeConfiguration` attachments on the committed
  flag-implementer / metrics-author `default` variations (samplingRate 1).
- **Provisioner:** passes `evaluationMetricKey` at config creation (required for
  judge mode), provisions judge-mode configs before agents (attachments reference
  them), and re-attaches `judgeConfiguration` via a follow-up variation PATCH —
  the create endpoint's inline `defaultVariation` silently drops it.
- **Verified e2e** against a scratch project: judges created + served, attachments
  present, re-provision idempotent (nothing touched).

### ✅ Judges verify evidence, not just the agent's self-report
- **Runtime:** the judge hook now appends a **VERIFIED EVIDENCE** section to the
  judge input — a node-scoped `git diff` of exactly the commits the judged agent
  landed (`shared/judgeEvidence.ts`; HEAD snapshot advanced per judged node;
  "no new commits" is itself evidence). Judges verify the report against the
  actual diff instead of taking the narrative at its word.
- **Judge instructions (both → variation v2):** added a "What you receive, and
  how to verify" section — claims contradicted by evidence score ≤0.2;
  material claims unverifiable from evidence cap the score at 0.6.
- **⚠ Comparability reset:** this is the one-time instruction edit anticipated in
  ADR 0007 — scores from before 2026-07-07 (~2 data points) are not comparable
  with scores after. Do not edit judge instructions again without logging here.
- Note: judge instructions deliberately contain NO `{{message_history}}`-style
  template variables — that's the legacy judge format (the SDK strips such
  messages). History + evidence arrive in the judge's user message at run time.

## 2026-07-06

### ✅ Judges attached to the coding agents (quality layer for the model A/B)
- **New judge AI configs** (mode `judge`, factory project, model Sonnet 4.6):
  `autofactory-judge-implementation-quality` and `autofactory-judge-metrics-quality`.
  Each scores its agent's output 0..1 with reasoning (criteria: honesty/consistency
  first, then safety, correctness, release wiring, completeness), recording against
  the auto-generated `$ld:ai:judge:<key>` metric.
- **Attached** (samplingRate 1 = every run) to BOTH the `Sonnet 4.6` and
  `Composer 2.5` variations of `autofactory-flag-implementer` (v8/v3) and
  `autofactory-metrics-author` (v8/v2) — scores land per-variation, giving the
  Composer-vs-Sonnet A/B its missing quality dimension (Monitoring tab → the
  judge metric; Metrics → Judge metrics).
- **Execution** is in the runtime (ADR 0007): the SDK's `Judge` class over our
  provider seam (Anthropic forced-tool-use / Cursor hermetic one-shot; Vega skips).
  The code reviewer remains the gate — judges are sampled, non-blocking evaluators.
- **⚠ Comparability:** judge instructions are part of the measurement instrument.
  Any edit to them resets cross-time comparability — log edits here.

## 2026-06-26

### ✅ Prevent false `flag_created=true` (tool-owned tags + F19)
- **Why:** a LaunchDarkly API 401 on `create_flag` produced GREEN runs because the
  agent set `flag_created=true` via `tag_conversation` despite the tool failing —
  a passing pipeline with no flag (verified: 5/5 demo flags were 404 while 2 runs
  reported success). The honest failures correctly stalled at the metrics edge.
- **Code fix (shared, both providers):** `flag_created` / `flag_key` /
  `metrics_created` / `metric_keys` are now **tool-owned** — set only by
  `create_flag` / `create_metric` on a real success and stripped from any
  agent-supplied `tag_conversation` call. The agent literally cannot fake them.
- **Config fix:** added **F19** to the flag-implementer instructions on BOTH the
  `Sonnet 4.6` (v7) and `Composer 2.5` (v2) variations — only HTTP 409 (exists) is
  success-via-reuse; any other `create_flag` error is a hard failure (tag
  `flag_created=false`, don't wire/manifest/claim success, stop). Reinforces the
  code fix so the agent's downstream behavior stays honest too.

## 2026-06-25

### ✅ Multi-context (`service` + `run`) for per-agent model A/B
- **Change (code):** the pipeline targeting context is now a multi-context — a
  static `service` kind (flag eval, AI-config/graph targeting, operational flags)
  plus a `run` kind with a fresh UUID per run.
- **How to use (LD-side, per agent):** to A/B an agent's model (e.g. Composer vs
  Sonnet on a coding agent), add the model variations and set that AI config's
  **percentage rollout / experiment randomization unit to the `run` context kind**.
  Each config has its own salt, so the agents bucket INDEPENDENTLY off the one run
  key — per-node A/Bs are decorrelated, no per-node key needed. A fresh UUID per
  run means re-runs are independent samples.
- **Keep on `service`:** `auto-factory-ai-provider` and `auto-factory-approval-gates`
  targeting must stay on `service` (or fallthrough) so they don't re-randomize.
- The `run` UUID is also stamped on the LLM-observability spans (`launchdarkly.run.id`)
  to group a run's agent spans.

### ✅ LLM Observability for the Cursor provider
- **Change:** Registered the LaunchDarkly Observability plugin on the server SDK and
  emit a `gen_ai.*` OpenTelemetry span per Cursor agent run (model, token usage,
  prompt/output, status), correlated to the AgentControl config via the tracker's
  `getTrackData()`. Spans land in the factory project's (`auto-factory-prototype`)
  LLM Observability, alongside the AI Config metrics.
- **Why:** the Cursor calls run in Cursor's hosted service (no local LLM SDK to
  auto-instrument), so manual spans are how those runs become visible in LD. Verified
  live: traces appear in LaunchDarkly for demo PR #26.

### ✅ Chain model bumped to claude-sonnet-4-6
- **Change:** Set `modelConfigKey` = `Anthropic.claude-sonnet-4-6` on the served
  (`default`) variation of all five agent configs (research-planner, flag-implementer,
  metrics-author, flag-testing, code-reviewer) — previously `Anthropic.claude-sonnet-4-5`.
- **Note (where the model lives):** the model is configured via the variation's
  **`modelConfigKey`**, not the inline `model` object (which reads as `{}` in the
  management API). The AI SDK resolves `cfg.model.name` from that key at runtime —
  so the model IS derived from LD. The Anthropic runner uses it directly; the new
  Cursor runner maps it to Cursor's catalog (`cursorModel.ts`); Vega ignores it.
- **Why:** keep the chain on the current Sonnet; makes "model derived from LD" true
  for every provider (was effectively a code default before this was understood).
- Affects Anthropic runs on `main` too (it's the shared factory project), not just
  the Cursor branch — expected for a model-version bump.

### ✅ `cursor` variation added to `auto-factory-ai-provider`
- **Change:** Added a third variation, **`cursor`** (value `cursor`, name "Cursor"),
  to the `auto-factory-ai-provider` multivariate flag — alongside `anthropic`
  (default, idx 0) and `vega` (idx 1). Flag now at version 2; default unchanged.
- **What it selects:** the new `CursorAgentRunner` (`packages/shared/src/cursor/`),
  which runs each graph node as one Cursor agent via `@cursor/sdk`. It reuses the
  same sandbox tools (registered as Cursor `customTools`) and the same agent graph
  + AI configs — only the model brain changes. The agent **model + parameters are
  mapped from the AI config** (`cursorModel.ts`), and per-node metrics (duration,
  tokens, success/error) are recorded through the AI-config tracker, so Cursor runs
  show up in the same AI Config monitoring as the other providers.
- **Caveat (host, not choice):** Cursor inference runs on Cursor's hosted models,
  not LaunchDarkly's Bedrock instance, even when the mapping pins a Claude model.
- **Why here:** lets the deterministic GHA path use Cursor agents as the executor
  (distinct from the non-deterministic Cursor automation front ends). See ADR 0006.

## 2026-06-23

### ✅ Per-step approval gates (`auto-factory-approval-gates` flag)
- **New operational flag** in the factory project: `auto-factory-approval-gates`,
  a **JSON flag** whose value is an array of agent node keys (e.g.
  `["autofactory-flag-implementer"]`). The chain pauses BEFORE each listed
  agent until a human approves. Default `[]` = no gates (current behavior).
  Read natively via the SDK (same pattern as `auto-factory-ai-provider`).
- **Independent of `APPROVAL_MODE`.** `APPROVAL_MODE` still governs whether the
  FINISHED chain auto-applies; gates pause MID-chain (before a step's side
  effects). The original ask — approve after research, before flag creation —
  is `["autofactory-flag-implementer"]`.
- **How approval is given:**
  - **GitHub Action:** the run halts and comments which PR label to add
    (`af-approve:<nodeKey>`); adding it re-triggers the workflow (template now
    includes the `labeled` event) and the re-run proceeds. Approval persists
    across pushes. A pending gate is a red check (action required).
  - **Cursor extension:** an interactive Approve/Stop modal blocks the in-process
    run at each gate.
- Code: `packages/shared/src/approvalGates.ts` + a `GateController` hook in the
  walker; `packages/phase1-resource-factory/src/labels.ts` for the GHA labels.

### ✅ Operational flags now bootstrap-provisioned (off by default)
- **Change:** the two operational flags (`auto-factory-ai-provider`,
  `auto-factory-approval-gates`) now have committed definitions under
  `config/agentcontrol/flags/`, and `config-bridge provision`/`seed` (hence
  `npm run bootstrap`) create them in the factory project alongside the AI
  configs + graph. Previously only AI configs + graphs were provisioned, so a
  fresh consumer project had no operational flags until created by hand.
- **Safe by default:** each is provisioned **off** — provider serves `anthropic`,
  gates serve `[]` (no gates) — so behavior is unchanged until a maintainer flips
  it. Provisioning is idempotent and 404-tolerant: an existing flag (and its
  targeting) is never overwritten.
- Code: `packages/config-bridge/src/provision.ts` (`provisionFlag`, `flagsDir`),
  `config/agentcontrol/flags/*.json`.

## 2026-06-22

### ✅ Tag registry as source of truth (issue #9 item #5)
- **Change:** added `config/agentcontrol/tags.json` — the machine-readable
  registry of every routing/verdict tag (producer, `llm` vs `tool` production,
  the graph edges that consume it, and whether approval/manifest reads it).
- **Guard upgrade:** `check-configs` now validates against the registry exactly
  instead of a token heuristic — bidirectional graph⟷registry edge checks,
  producer verification (an `llm` tag must appear in its agent's instructions; a
  `tool` tag must be in the write-tool auto-set), and a README-table⟷registry
  equality check.
- **Resolved a real drift it surfaced:** `flag_worthy` was emitted by the
  research planner and forced by the runner, but consumed by no edge and absent
  from the README table. Documented it as **advisory** (recorded but not routed
  on) in both the registry and the README "Canonical agent tags" table. Also
  fixed a stale `approval.ts` path in the README (moved to `packages/shared`).

### ✅ Fixed invalid `tag_conversation` signature in committed configs + added a routing-contract guard
- **Problem (issue #9, failure mode #1):** `autofactory-metrics-author` and
  `autofactory-research-planner` instructed the model to call
  `tag_conversation(key="…", value="…")`, but the tool only accepts a single
  `tags` object (`{"tags": {"k": "v"}}`). With the wrong signature the model
  emits no tags, so the chain stalls and reports a misleading verdict.
- **Fix:** rewrote the 5 affected calls to the valid form
  `tag_conversation({"tags": {"…": "…"}})` (metrics-author: metrics_created /
  metric_keys / needs_tests; research-planner: flag_worthy / skip_flagging).
  These are the committed seed copies; re-sync the live LD configs to match if
  they still carry the old form.
- **Guard:** new `npm run check:configs` (`scripts/check-configs.mjs`, wired
  into CI + a test) lints for the invalid signature and checks that every graph
  edge's `require_tags`/`skip_if_tags` is producible by some agent or write
  tool — so this class of routing-contract drift fails fast. Addresses issue #9
  item #2; the runtime forced-tag-call (item #1) is the next step.

## 2026-06-11

### ✅ Committed the canonical public copies of all five agent configs
- **Change:** exported each `autofactory-*` config's `default` (Anthropic) variation
  from the live project into `config/agentcontrol/ai-configs/*.json` (provision
  format). Versions at export: planner v2, implementer v4, metrics-author v5,
  testing v5, reviewer v3. Vega variations stay live-only (internal runtime details).
- **Why:** external consumers provision from these files (`npm run bootstrap`);
  the directory was intentionally empty before (old I3). Convention going forward:
  edit in LD → re-export here → log in this changelog.

### ✅ Code reviewer: metric-key vs event-key convention (false-positive REJECT fix)
- **Problem:** on demo PR #10 the reviewer REJECTED (risk high) because the code's
  `track()` events (`enable-haiku-endpoint-error`) didn't string-match the metric
  KEYS (`enable-haiku-endpoint-error-rate`) — but that difference is the designed
  convention; the metric's `event_key` field is the link, and the Metrics Author's
  brief showed the correct pairing.
- **Change (`autofactory-code-reviewer` `default` v3):** added a "Metric keys vs.
  event keys (do NOT flag this as a mismatch)" section — validate `track()` events
  against each metric's `event_key`, never against metric keys; flag only events
  matching NO metric. Also added the Metrics Author to R09 (fail-safe telemetry,
  event/metric linkage) and to the `agent` attribution enum.

## 2026-06-10

### ✅ Metrics-author tag convention: `flag:<flag-key>` → `flag-<flag-key>`
- **Change:** Updated BOTH `autofactory-metrics-author` variations (`default` and the
  preserved "Vega Chain" copy): the flag-reference tag convention is now
  `flag-<flag-key>` with an explicit "LaunchDarkly tags cannot contain `:`" note.
- **Why:** observed on demo PR #9 — the instructions said `flag:enable-...` but the
  metric landed with `flag-enable-color-endpoint` because LD tag validation rejects
  colons. The convention now matches what actually gets stored, so the future metric
  cleanup job can rely on a mechanical prefix scan. Repo-side, the `ldWriter` test's
  example tag was aligned to the valid form.

### ✅ Synced the live `gha-auto-factory` graph with the committed copy (capabilities now live)
- **Change:** Full-object REST PATCH of the live graph: added the `capabilities`
  grants to three edges (→flag-implementer `["create_flag","edit_files"]`,
  →metrics-author `["create_metric","edit_files"]`, →flag-testing `["edit_files"]`)
  and removed the inert `prompt_template` from every edge (completes CLEANUP #28 on
  the live side). Kept the live `max_turns` values.
- **Why this matters:** the action resolves the graph **live** via the AI SDK's
  `agentGraph()` — the committed `graphs/auto-factory.json` is a record, not the
  runtime source. Until this PATCH, the edge grants only existed in the committed
  copy and the runner was riding on its hardcoded `NODE_CAPABILITIES` fallback.
- **Reconciliation:** the committed copy's testing→code-reviewer `max_turns` was 15
  while live ran 30; updated the committed file to 30 so the record matches reality.

### ✅ Rewrote the live `autofactory-research-planner` instructions for the Anthropic tool surface
- **Change:** Replaced the `default` variation's instructions (now v2). The Vega-era
  original is preserved as the `default-configuration-copy` variation (see the
  variation-pattern entry below).
- **What changed:** tool references fixed (`git_diff`/`read_file`/`list_dir`/`grep`
  instead of `Read`/`Glob`/`Bash` + `gh pr diff`); dropped the four interpolation
  variables the action never supplies (`FILES_CHANGED_COUNT`, `LINES_CHANGED`,
  `CHANGED_FILES_SUMMARY`, `CI_CONTEXT`) — `git_diff` is the changed-files source now;
  replaced the internal-monorepo "Repo Structure Reference" (and `flagfn.NewBool` /
  `createFlagFunction` patterns) with repo-agnostic detect-from-the-code guidance;
  added an explicit Chain Routing Tags section (`flag_worthy`, and `skip_flagging`
  documented as a chain short-circuit — the old text wrongly said the planner's output
  was "NOT a routing decision").
- **Kept:** the two-phase research → brief structure, classification taxonomy, and the
  flag/test/review brief fields downstream agents parse.

### ✅ Pattern: per-provider variations on each AI config
- **Decision:** each `autofactory-*` config keeps its **`default` variation as the
  Anthropic-surface instructions** (the current primary path) and a separate
  **Vega-surface variation** (e.g. "Vega Chain" / "Default Configuration - Copy")
  preserving the Bash/MCP-tooling instructions. Later, targeting can serve the right
  variation off the `auto-factory-ai-provider` flag so instructions switch with the
  execution backend. No targeting changes yet — Anthropic stays the served default.

### ✅ Rewrote the live `autofactory-metrics-author` instructions for the Anthropic tool surface
- **Change:** Replaced the `default` variation's instructions (now v2, renamed
  "Vega Chain" → "Default Configuration"). This is the "separate config update
  entry" promised by the 2026-06-09 `create_metric` code entry below.
- **What changed in the instructions:**
  - Dropped the Vega Environment section (clone-the-repo, `/workspace`, git identity)
    — the Anthropic runner operates in the pre-checked-out PR branch.
  - Tool surface is now the real sandbox set: `read_file`/`list_dir`/`grep`/`git_diff`/
    `tag_conversation` + granted `create_metric`/`edit_file`/`write_file`/`run_tests`/
    `commit_and_push`. No Bash/curl REST payloads (the `create_metric` tool owns the
    category → LD metric-shape mapping), no LD/observability MCP tools.
  - Reuse-first (M02/M07) reworded for what the agent can actually see: code-level
    reuse (existing `track()` events on the flagged path) + `create_metric`
    idempotency, instead of `launchdarkly_list_metrics` / trace queries.
  - Kept: guarded-release framing, M-rules, the three categories, killswitch/pause/
    monitoring classification, naming convention, manifest loop-closure
    (`releaseOverrides.metricKeys` + `randomizationUnit`), chain output + routing tags.
  - New: latency events must pass elapsed ms as the `track()` metric value; M01 skip
    now explicitly tags `metrics_created=false` + `needs_tests=true`; notes that
    `create_metric` auto-sets `metrics_created`/`metric_keys`.
- **Why:** the old instructions were written for the Vega runtime; on the Anthropic
  provider the agent degraded to a markdown spec (demo PR #8). Pairs with the
  `create_metric` capability + graph-edge grant in the entry below.

## 2026-06-09

### ✅ Metrics Author can now actually create metrics on the Anthropic path
- **Problem:** the metrics-author's instructions were written for the Vega runtime
  (Bash + curl to the metrics REST API + observability/LD MCP tools). On the default
  **Anthropic** provider it had none of those — no metric-creation tool and no
  `edit_files` grant — so it degraded to writing a markdown spec and tagged
  `metrics_created=false`. (Confirmed on demo PR #8.)
- **Code (tooling repo):** added a `create_metric` agent tool + `LdResourceWriter.createMetric`
  (maps category error/latency/business → LD metric fields; idempotent on 409) and a
  new `create_metric` capability.
- **Graph:** the edge into `autofactory-metrics-author` now grants
  `capabilities: ["create_metric", "edit_files"]` (so it can instrument a `track()`
  event AND create the metric off it). Fallback `NODE_CAPABILITIES` also updated.
- **Instructions:** the live `autofactory-metrics-author` config must be rewritten to
  the Anthropic tool surface (`create_metric` / `edit_file` / `read_file`) instead of
  Bash/curl/MCP — see the separate config update entry.

### ✅ (cleanup) Dropped inert `prompt_template` from the committed graph copy
- **Change:** Removed `"prompt_template": "{{PR_NUMBER}}"` from every edge of the
  committed `graphs/auto-factory.json`. The graph walker owns prompt construction
  for **every** provider (it never forwards `prompt_template` to Vega), so the field
  was inert. Documented the handoff fields the walker DOES honor (`require_tags`,
  `skip_if_tags`, `max_turns`, `request_type`) in this directory's README.
- **Note:** this only touched the committed local copy. The live LD graph may still
  carry the field; it's harmless (inert) but can be removed there too. See CLEANUP #28.

### ✅ (cleanup) Edge-declared agent `capabilities` (config-driven write access)
- **Change:** Added a `capabilities` array to two edges of the committed
  `graphs/auto-factory.json`: the edge into `autofactory-flag-implementer` grants
  `["create_flag", "edit_files"]`, the edge into `autofactory-flag-testing` grants
  `["edit_files"]`. The Anthropic runner reads these instead of a hardcoded
  config-key map (which it keeps only as a fallback). Always intersected with the
  global `ENABLE_FLAG_CREATION` / `ENABLE_CODE_CHANGES` toggles.
- **Why:** "which agent can write" should be config, not code — a renamed/added
  agent no longer silently lands read-only. See CLEANUP #24. To take effect on the
  Vega-seeded path, add the same `capabilities` to the live LD graph's edges.

### ✅ 0. Provider-selection flag (`auto-factory-ai-provider`) — foundational
- **Change:** Created a multivariate string flag in the factory project: variations
  `anthropic` / `vega` (extensible to other providers), **default `anthropic`**.
- **What it does:** the Phase 1 runtime evaluates it (server SDK) to pick the agent
  execution backend — run the chain locally on the Anthropic API, or dispatch to Vega.
  Flip it in LaunchDarkly to switch; no code/workflow change needed.
- **Why:** decouples "which AI runs the agents" from the pipeline so we can move off
  Vega without losing it, and swap providers later.

### ✅ 1. Added the Metrics Author agent + rewired the graph
- **Change:** Added `autofactory-metrics-author` as a core node in the chain and
  rewired `gha-auto-factory` to:
  `research-planner → flag-implementer → metrics-author → flag-testing → code-reviewer`.
- **Handoff conditions:** flag-implementer → metrics-author requires `flag_created=true`;
  metrics-author → flag-testing requires `needs_tests=true`.
- **Why:** The release pipeline needs metrics authored for guarded releases; the
  metrics step belongs between flag creation and testing.

### ✅ 2. Increased the Code Reviewer turn budget
- **Change:** Raised `max_turns` on the `flag-testing → code-reviewer` edge handoff
  to **30** (verified live).
- **Note:** An earlier attempt to set this to 25 did **not** persist — the live
  graph was still 15 when checked on 2026-06-09, which is why the reviewer kept
  running out of turns. Now confirmed at 30 via full-object REST PATCH.
- **Why:** The reviewer was hitting its turn cap before reaching a verdict. (Turns
  are a cushion; the real cause was the reviewer being unable to see the diff —
  see #4.)

### ✅ 3. Test agent (`autofactory-flag-testing`) — de-scoped + execute (v2)
- **Changes applied** (variation `default` → version 2):
  1. **Explicit execution:** "generate tests" → "use `write_file`/`edit_file` to
     create the test file(s), then `commit_and_push` once. Do NOT merely
     describe/design the tests."
  2. **De-scoped to flagged behavior only:** removed ROLE 1 (general coverage for
     all modified production code — rules T03/T04/T21–T25 and skip-conditions
     T14/T15). The agent now writes ONLY flag-on/flag-off tests for the code paths
     the flag-implementer wrapped (rules T01/T02/T08/T12/T13).
  3. **(Extra) Repo-adaptive test conventions:** replaced the hardcoded internal-monorepo
     Go/TypeScript patterns (`testify`, `@internal/testing`, Vitest, the
     `T26/T27` framework constraints, `/app/run_validation.sh`) with "detect and
     follow the repo's existing framework; else the language's standard (e.g.
     pytest for Python)." Needed because the demo app is Python/Flask — the
     internal-monorepo-only patterns would have produced Go/TS tests for Python code.
- **Why:** The agent has write + push tools now (PR
  launchdarkly-labs/launchdarkly-auto-factory#1, merged), but on demo PR #3 it
  described tests instead of creating them, and its scope/patterns were wrong for
  the target repo.
- **Follow-up (version 4):** switched its diff reference to the new `git_diff` tool
  (it has no shell) and reworded "Validation" to acknowledge it cannot execute
  tests (no bash) — verify test files are syntactically valid instead.

### ✅ 4. Code Reviewer (`autofactory-code-reviewer`) — let it SEE the diff (v2)
- **Root cause (not turns):** the reviewer was told to run `gh pr diff` / use
  `Bash`, but in our runtime it has **no shell, bash, or gh** — only read-only file
  tools. So it couldn't see the change set and burned all its turns reading files
  one-by-one to infer the diff, never reaching a verdict.
- **Changes applied** (variation `default` → version 2):
  1. Added a read-only **`git_diff`** tool to the agent runtime (shared sandbox
     tools; available to all nodes). Wired `pr_base` through the action/workflow so
     it diffs `base...HEAD`.
  2. Reviewer instructions: call **`git_diff` FIRST** to see the full change set
     (incl. agent enrichment commits), then read specific files. Aligned tool names
     (`Read`/`Glob`/`Bash`/`gh pr diff` → `read_file`/`list_dir`/`grep`/`git_diff`)
     and stated it has no shell access.
  3. Verdict stays **last** (step 5): analyze, then emit `review_approved` /
     `risk_level`. (We explicitly did NOT adopt "verdict first" — a verdict should
     follow the analysis, not precede it.)
- **Why:** Treat the cause (can't see the diff), not the symptom (turn cap). Turns
  raised to 30 (see #2) as a secondary cushion.
- **Validated:** demo PR #4 (`/api/quote`) — reviewer ran to completion, called
  `git_diff`, and returned an accurate verdict (REJECT, 2 BLOCKING) catching a real
  test/impl mismatch. See #5.

### ✅ 5. Flag Implementer (`autofactory-flag-implementer`) — tool-accurate cleanup (v2), fail-safe reverted (v3)
- **Tool/pattern cleanup (v2, still in effect):**
  - Removed the internal-monorepo-specific SDK-helper patterns (`createFlagFunction` /
    `@internal/dogfood-flags`, `flagfn.NewBool` / `OnErrorLogAsError`), the
    `make go-generate` "Code Generation" section, and the `/app/run_validation.sh`
    "Validation" step — none apply in this runtime. Replaced with "match the repo's
    existing flag pattern."
  - Swapped `ldcli flags create` → the in-runtime `create_flag` tool, and push →
    `commit_and_push`. NOTE: `ldcli` is LaunchDarkly's official CLI (not an internal tool) —
    this was a swap to our current tool, not a "fix." See backlog below.
- **Fail-safe Task #3 — ADDED in v2, then REVERTED in v3 (decision "(a)"):** v2 had
  added "flag evaluation must FAIL SAFE … harden the shared helper" to keep the code
  consistent with the testing agent's resilience tests. We reverted it because:
  (1) LaunchDarkly's server SDK `variation()` is **already fail-safe by design**
  (returns the default on error, doesn't throw), so the PR #4 resilience test was
  over-specified; (2) the implementer wasn't honoring the instruction anyway (PR #5/#7
  left `_flag()` unhardened). We rely on the SDK's built-in fail-safe rather than imply
  defensive behavior we don't enforce. The testing agent only writes flag-on/flag-off
  tests now, so there's no test/impl conflict to reconcile. Current Task #3 is just
  "preserve existing behavior on the control path."

### ✅ 6. `run_tests` tool — testing agent runs what it writes (testing v5)
- **Change:** Added a `run_tests` agent tool (auto-detects pytest / `npm test` / `go test`,
  installs deps, returns pass/fail output), available to the edit-capable nodes. Testing
  agent → **version 5**: write tests → `run_tests` → fix failures (imports, fixtures,
  assertions) → only `commit_and_push` once green. Added guidance to ensure imports
  resolve for how the runner is invoked (module path / `conftest.py`).
- **Why:** The testing agent wrote tests it couldn't execute (no shell), so import/path
  errors slipped through on every run and the reviewer (correctly) blocked them — PR #4
  (test/impl fail-safe mismatch) and PR #5 (`from app import …` module-path error). Same
  shape as the `git_diff` fix: give the agent the ability to verify its own output. This
  is real code execution in the CI sandbox — the capability expansion we'd deliberately
  deferred until now.

### 🔜 Backlog — consider `ldcli` for flag creation
- Today the implementer creates flags via the REST-backed `create_flag` tool. Using
  LaunchDarkly's official CLI (`ldcli`) may be more efficient/idiomatic long-term.
  Revisit once the core chain is stable. (https://launchdarkly.com/docs/home/getting-started/ldcli)
