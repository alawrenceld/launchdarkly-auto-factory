# ADR 0006 — Cursor SDK as a third execution provider

**Status:** accepted (2026-06-25). Extends [ADR 0005](0005-provider-seam-local-anthropic-execution.md).

**Context.** Phase 1's GitHub Action deterministically walks the LaunchDarkly agent graph,
dispatching one node at a time through the `AgentRunner` seam (ADR 0005). Two backends exist:
the local Anthropic tool-use loop (default) and hosted Vega. Separately, the Cursor *automation*
front ends (local + cloud) drive the same work non-deterministically — they read the AI configs
over MCP and act on them in one open-ended session. We wanted the deterministic GHA path to be
able to use **Cursor agents** as the model brain too, so the agent graph, capability gating, and
metrics stay identical and only the executor changes.

**Decision.** Add a third `AgentRunner`, `CursorAgentRunner` (`packages/shared/src/cursor/`),
selected by a new `cursor` variation on the `auto-factory-ai-provider` flag. Each graph node is one
Cursor agent run (`Agent.create` → `agent.send` → `run.wait`) via `@cursor/sdk`. It reuses the
existing `SandboxToolExecutor` — the same `create_flag` / `create_metric` / `tag_conversation` /
edit / `commit_and_push` tools — registered as Cursor `customTools`, so flag/metric idempotency and
the git/commit semantics are byte-for-byte the Anthropic path's. Only the model brain differs.

Three SDK realities shaped the design:

- **No system-prompt parameter.** The SDK has no system field, so the LD-resolved instructions are
  prepended to the message, with the **same `modeNote`** the Anthropic runner appends — the agents
  must behave identically across providers, so the instructions can't diverge.
- **Local-only custom tools.** Routing tags and LD writes have no built-in equivalent and
  `customTools` are local-only, so this is a **local agent** (`local: { cwd }`), not a cloud agent.
- **Model + parameters mapped from LaunchDarkly.** The AI config's `model.name` is matched against
  Cursor's catalog (`cursorModel.ts`: exact, then fuzzy, then a `CURSOR_MODEL` fallback); model
  parameters are applied only where an LD param id lines up with a parameter the chosen Cursor model
  accepts. So model selection is **derived from LD**, not hardcoded — same as the Anthropic path.

**Measurement.** Per-node generation metrics — duration, token usage (`RunResult.usage` →
`trackTokens`), and success/error — are recorded through the AI-config `tracker`, exactly as the
Anthropic runner does, so Cursor runs appear in the same AI Config monitoring dashboards as the
other providers (graph-correlated via the graph tracker).

**Consequences.**
- **Inference host differs.** Even when the mapping pins a Claude model, *all Cursor inference runs
  on Cursor's hosted models*, not LaunchDarkly's Bedrock instance. Tokens/cost flow through Cursor;
  the monitored "model" reflects the mapped id, not a Bedrock call. This is the real divergence —
  the model *choice* is from LD, the *execution host* is not.
- **Generic LD params usually drop.** Cursor model parameters are model-specific ids (e.g. `fast`),
  not generic `temperature` / `maxTokens`, so those typically have no Cursor equivalent and are
  reported as dropped (logged, not silently ignored).
- **Packaging.** `@cursor/sdk` is a webpack-style bundle with dynamic chunk loading and an optional
  `bun:sqlite`, so esbuild can't inline it. The action bundle marks it **external** and the runner
  **lazy-imports** it, so only the `cursor` path loads it — the Anthropic/Vega bundle is unchanged
  and doesn't require the package or Node ≥22.13. The action runtime is bumped to **node24** (the
  SDK requires ≥22.13); the cursor path needs `@cursor/sdk` resolvable at runtime (a dependency of
  `@auto-factory/shared`, so `npm ci` provides it — a standalone consumer of the action would need
  it installed).
- **No max-turns cap.** The SDK exposes no per-run turn limit (only `cancel()`); the `maxTurns`
  handoff hint is informational on this path. The routing-tag safety net (a forced follow-up
  `tag_conversation` turn) is preserved, so a node still can't silently stall the chain (issue #9).
