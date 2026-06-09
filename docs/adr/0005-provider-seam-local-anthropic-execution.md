# ADR 0005 — Provider seam; default to local Anthropic execution

**Status:** accepted (2026-06-09). Supersedes in part [ADR 0004](0004-vega-transport-seam.md).

**Context.** Phase 1 was designed to dispatch all agent work to Vega, LaunchDarkly's hosted AI
(see ADR 0004). But the public/partner-facing Vega dispatch API is gated on an entitlement we
don't have for the prototype, so the Vega path could not actually run agents end-to-end. We needed
the agents to run *for real* — create flags, wire code, write tests, review — to validate the
pipeline and demo it to design partners.

**Decision.** Introduce a provider-agnostic execution seam, `AgentRunner` (`runNode(req) → result`),
and select the backend at runtime from the `auto-factory-ai-provider` LaunchDarkly flag (default
`anthropic`, alternative `vega`):

- **`AnthropicAgentRunner` (default).** Runs the graph locally against the Anthropic API: each AI
  config's resolved instructions become the agent's system prompt, and the agent drives a tool-use
  loop with **capability-gated sandbox tools** (read/list/grep/git_diff always; create_flag,
  edit_file, commit_and_push only for nodes granted the capability).
- **`VegaAgentRunner`.** A thin adapter over the existing `VegaClient`/`VegaTransport` (ADR 0004),
  preserved unchanged for when the entitlement lands.

LaunchDarkly stays load-bearing regardless of provider: the **LD AI SDK resolves the agent
configs and the agent graph, interpolates instructions, and records per-node + graph metrics
natively** (`ldClient.variation` for the provider flag; `aiClient.agentGraph(...)` for the graph).
The graph walker is identical for every provider — it only sees `AgentRunner`.

**Consequences.**
- An agent loop now **ships in this repo** (`packages/shared/src/anthropic/`) — the plan's original
  "no agent loop ships here; we're integration glue" framing (plan §2) no longer holds for the
  default path. Documented as a dated note in plan.html.
- Phase 1 runs **end-to-end today** on the Anthropic provider against a live demo repo.
- The Vega path is **preserved, not deleted** — flipping the flag to `vega` re-routes to the hosted
  runtime with no walker/action changes. ADR 0004's transport seam stays valid for that path.
- New surface to keep honest: capability grants currently key off agent config keys in the runner
  (a known coupling — see CLEANUP #24), and the sandbox tools are the security boundary for agent
  file access (see CLEANUP #29).
