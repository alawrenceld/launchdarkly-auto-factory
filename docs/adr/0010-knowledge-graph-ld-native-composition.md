# ADR 0010 — Impact analysis from LaunchDarkly-native sources, not a code-graph tool

**Status:** accepted (2026-07-10). Implementation in progress.

**Context.** The agents make release decisions with no structural picture of the system
they're changing: the research planner scores risk from the diff alone, the flag implementer
picks wrap points file-by-file, the metrics author guesses what a changed path touches, and
nothing knows that a change to one service's handler matters to the two services that call
it. A code knowledge graph — dependencies plus the flags wrapped around them — would inform
all of them (blast radius → `risk_score`, wrap-point selection, manifest scope, business-metric
discovery, cross-service test surface).

The obvious route is a third-party code-graph tool. We evaluated the field and hands-on
spike-tested the three best candidates against the demo estate (a five-service, three-language
application). The best performer found 10/10 ground-truth dependency edges and its artifact
model matched our architecture exactly. But every viable tool in this space is months old,
effectively single-maintainer, and pre-1.0 with a churning schema; the functionally strongest
candidate is noncommercially licensed. Baking any of them into a prototype that design
partners install is a support commitment we shouldn't make, and shipping the concept as an
"unsupported optional example" buries it.

The spike's real lesson: for what our agents actually consume, the extractor is over-specced.
Blast radius at *service* granularity, flag wrap points, and changed-files→service mapping
cover the intended consumers' v1 needs — none of which requires a resolved call graph. And
LaunchDarkly already owns most of those edges.

**Decision.**

1. **Compose the graph from LaunchDarkly-native sources.** A small composer
   (`packages/shared/src/graph/`) builds a per-run artifact from three inputs:
   - **service → service edges, derived from observability traces.** The o11y SDKs' spans
     carry service names, parent links, and outbound-call targets; grouping client spans by
     source service → target host yields the service map. The query surface is the hosted
     observability MCP endpoint, authenticated headlessly with `Authorization: Bearer
     <LD API key>` — verified live from CI: the first enriched run derived real service
     edges from the estate's traffic. Any fetch failure still degrades to a warning rather
     than a failed run, and the auth scheme is env-overridable (`LD_O11Y_AUTH`). A
     first-party service-map read API remains the ask to the observability team — it would
     replace this client-side aggregation with the product's own.
   - **flag → code edges (wrap points), from `ld-find-code-refs` run in-pipeline at the PR's
     SHA** with file output. Running at the PR SHA is deliberate: refs attached to the flag
     in LaunchDarkly reflect the last default-branch scan and cannot include the flag wiring
     this PR just added. The output feeds three consumers: graph edges, evidence appended to
     the code reviewer's input, and an artifact recorded alongside the release manifest for
     eventual flag cleanup. (The app repo separately runs the standard find-code-refs action
     on merge — normal intended usage.)
   - **changed files → service**, from the same directory-mapping convention Beacon's
     `services.yaml` already uses.
2. **One agent tool, behind a flag.** A `queryGraph` capability (granted per node in the
   agent graph, like `create_flag`) exposes `query_dependencies` — dependents/dependencies of
   a node, plus a zero-argument blast-radius preset over the PR's changed files. A new
   `auto-factory-knowledge-graph` boolean flag (provisioned **off**) gates the capability, so
   enriched and un-enriched runs can be compared: the judge scores (ADR 0007) are the
   instrument, and the graph must move them — or demonstrably improve scope/intent/test
   coverage — to earn permanence.
3. **The metrics author grows the map (the telemetry loop).** Trace-derived edges only cover
   instrumented, exercised paths — so coverage becomes an agent responsibility. The metrics
   author's instructions now encode: (a) a guardrail metric must be attributable per
   randomization unit per variation — valid backings are custom `track()` events and trace
   metrics on span attributes, and **pre-aggregated OTel metrics never qualify**; (b) trace
   metrics are only valid when the flag is evaluated *inside* the active span, because the
   observability SDK's flag `afterEvaluation` hook enriches the active span (client-side, a
   child span) — the metric can only be built on span attributes within a trace that
   evaluates the flag; (c) when a service already uses the observability SDK, the agent must
   span-cover the flagged path (flag evaluated in-span, `<flag-key>.<attribute>` attributes)
   — growing the very telemetry the composer reads. The demo estate is instrumented once as
   a baseline; subsequent demo PRs intentionally ship uninstrumented so the agent's
   gap-filling is visible. Each processed PR widens the map that informs the next PR.
4. **Deliberately not built (v1):** file-level import extraction. The composer's artifact
   schema is source-agnostic, so a static import extractor (or a future first-party source)
   can be added without touching the agents if the A/B shows service granularity isn't
   enough. Cross-repo composition is likewise deferred — the demo estate is multi-service in
   one repository.

**Consequences.**
- No third-party graph dependency; every edge source is a LaunchDarkly product surface or a
  convention the estate already follows. The prototype dogfoods observability and code
  references instead of wrapping an external tool.
- Runtime-derived edges reflect the *deployed* topology — honest for "what does production
  look like around this change," blind to never-exercised paths and to edges the PR itself
  introduces. The find-code-refs source has the opposite freshness profile (PR-SHA-accurate);
  the composer records provenance per edge.
- The graph's quality now depends on telemetry coverage, which is exactly the loop item 3
  closes — and a coverage gap is visible in the artifact rather than silently wrong.
- Trace metrics are Early Access: guarded rollouts only (no experiments), account enablement
  required. Creation IS API-possible (corrected 2026-07-13): the regular metrics POST with
  `kind: "trace"`, a `traceQuery` span filter, `dataSource: {key: "launchdarkly-hosted"}`,
  and — for numeric metrics — `traceValueLocation` (the beta API version header is
  required). `create_metric` supports this via `trace_query`, so the metrics author creates
  trace-backed guardrails directly when the flag-evaluated-in-span pattern holds, and falls
  back to `track()` events otherwise.
- If service-level granularity proves insufficient, the fallback is known and measured: the
  spike-winning static extractor's artifact can be merged in as an additional source.
