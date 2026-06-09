# ADR 0004 — Vega behind a transport seam (stub until the public API exists)

**Status:** accepted — **superseded in part by [ADR 0005](0005-provider-seam-local-anthropic-execution.md)** (Vega is now one provider behind the `AgentRunner` seam; the default is local Anthropic execution).

**Context.** Phase 1 dispatches agent work to Vega (LaunchDarkly's hosted AI). The reference reaches it
over internal-only infrastructure; the public/partner-facing dispatch API is gated on an entitlement
the prototype doesn't yet have.

**Decision.** Define a stable `VegaTransport` interface (`dispatch` + `getStatus`) and a `VegaClient`
that polls to terminal. Ship a `StubVegaTransport` that throws. The graph walker and action code against
the interface, never the transport.

**Consequences.** All of Phase 1's orchestration (graph walking, edge conditions, approval) is built and
**unit-tested today against a fake transport**. Wiring the real Vega API is a localized change in one
factory function — no churn in callers.
