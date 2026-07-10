# Knowledge Graph — Plan & Locked Decisions

*(Untracked planning note, 2026-07-10. Sequence: **release intent ships first**; return here after.
KG's value will be measured against the judge-score baseline accumulating in the meantime.)*

## Goal

Map code dependencies + the flags wrapped around them, across repos/services, to give agents
traceability and impact analysis — informing research (blast radius), flagging (wrap points),
release manifests (scope + intent suggestions), business metrics discovery, and larger
contract/integration tests. End state: "flag and release in the context of our larger work,"
not "flag this small thing."

## Locked decisions

1. **Release-intent capture (context for KG's later suggestion role):** approvers edit
   `releaseIntent` in the manifest on the PR branch. Agents PRE-FILL the full intent skeleton
   **including blank fields** so humans see what's expressible. Not brittle: tolerant parsing +
   a self-healing pass (possibly a small manifest-repair agent) runs before any deterministic
   execution — typos must not break releases.
2. **Intent execution: deliberately deferred.** Assume LaunchDarkly-native multi-phase/staged
   releases are coming; Beacon must NOT grow its own scheduler/staging. Beacon stays a
   translator to LD primitives.
3. **Proving ground: grow the demo estate.** "Demo too small" means build bigger demos, not
   skip the KG. Multi-repo + distributed systems to mirror the end state. Already available:
   `ttotenberg-ld/launchdarkly-autofactory-demo` (Flask + Express) and
   `ttotenberg-ld/launchdarkly-autofactory-application` (gateway + services — the bigger one).
   Expect to add cross-repo/service dependencies deliberately (shared contracts, service
   calls, shared libs) so impact analysis has something real to trace.
4. **Residence: per-repo artifact, no hosted service.** Graph generated in CI, exposed to
   agents as a query tool (fits the hermetic architecture; freshness = regenerate per run or
   cached per SHA). Cross-repo view = compose per-repo artifacts, not a central server.
5. **Tooling: undecided.** Graphify was an example, not a choice; Tom will supply more
   candidates. First step of the track is a tool-eval spike (candidates + tree-sitter-based
   extraction + language-native tooling) against the real demo estate (Python, JS/TS at
   minimum).

## Intended consumers (in likely build order)

- **Research planner** — impact analysis / blast radius → better classification + `risk_score`.
- **Flag implementer** — wrap-point selection, cross-service flag awareness.
- **Release manifest** — scope (frontend/backend/fullstack) derived, `releaseIntent`
  suggestions (e.g. prerequisite flag relationships discovered from the graph).
- **Metrics author** — business-metric discovery from what the changed path actually touches.
- **Testing** — contract/integration test surface across service boundaries.

## Phase sketch (when we return)

0. Grow the demo estate (cross-repo dependencies worth tracing; flags spanning services).
1. Tool-eval spike → pick extraction approach; prove on both repos.
2. CI artifact generation + freshness model (per-SHA), incl. flag→code wrap-point mapping.
3. Agent query tool (`query_dependencies` or similar) + prompt integration, **behind a flag**
   so enriched vs. un-enriched runs can be compared.
4. Measure: judge-score A/B (enriched vs. baseline) + concrete traceability demos
   (e.g. "this change affects service B through contract X; flag exists upstream").

## Measurement

Judge scores (implementation-quality / metrics-quality) are the instrument: baseline is
accumulating now on un-enriched agents; the KG lands as a flagged enrichment and must move
the scores (or demonstrably improve scope/intent/test coverage) to earn its keep.
