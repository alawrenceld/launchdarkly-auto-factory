# ADR 0003 — Phase 1 triggers on PR open (no label gate)

**Status:** accepted

**Context.** The reference build is label-gated: a `vega:<graph>` label on a PR starts the run. That's
a deliberate safety/cost gate, but it adds a manual step.

**Decision.** The prototype triggers automatically on `pull_request` `opened`/`synchronize`/`reopened`
— **no label gate**. Open a PR, the agents run.

**Consequences.** Maximum "splash" and minimal developer friction (the explicit goal). Costs: every PR
invokes the agent chain (the Research agent's triage short-circuits flagless PRs early, limiting waste).
A path/size filter can be added later if trivial-PR noise becomes a problem.
