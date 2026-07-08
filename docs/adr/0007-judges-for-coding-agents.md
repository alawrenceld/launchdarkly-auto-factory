# ADR 0007 — Judges as the quality layer for the coding agents

**Status:** accepted (2026-07-06). Builds on [ADR 0005](0005-provider-seam-local-anthropic-execution.md)
and [ADR 0006](0006-cursor-sdk-provider.md).

**Context.** The per-agent model A/B (Composer vs Sonnet on the coding agents) measures tokens,
duration, and success — but has no *quality* dimension. Separately, the code reviewer is a
control-flow **gate** (its verdict drives the approval decision), which makes it the wrong place
to hang model-comparison metrics: gates must run every time and decide, evaluators should score.

**Decision.** Add LaunchDarkly AgentControl **judges** as a sampled, non-blocking evaluation
layer on the two coding agents where the A/B splits:

- `autofactory-judge-implementation-quality` → attached to both `autofactory-flag-implementer`
  variations (Sonnet 4.6 + Composer 2.5).
- `autofactory-judge-metrics-quality` → attached to both `autofactory-metrics-author` variations.

Both judge configs live in the factory project (mode `judge`, model Sonnet 4.6, samplingRate 1),
score 0..1 with reasoning against explicit criteria (honesty/consistency first, then safety,
correctness, release wiring, completeness), and record against their auto-generated
`$ld:ai:judge:<key>` metric — **on the evaluated node's tracker**, so scores surface
per-config-variation in AI Config monitoring. That makes the A/B a cost-vs-quality comparison.
The code reviewer stays exactly as it is: the gate.

**Execution: through the provider seam.** LaunchDarkly does not run judges for an external
runtime — the AI SDK's managed path only auto-executes judges on its built-in providers
(openai/langchain/vercel). We reuse the SDK's exported `Judge` class (it owns sampling, the
evaluation-input format, the `{score, reasoning}` structured-output schema, and parsing) and
supply the one piece it needs: a `Runner` implemented over our providers
(`packages/shared/src/judges.ts`):

- **Anthropic**: one forced-tool-use completion (`record_evaluation` with the evaluation schema
  as input schema) — structured output without free-text parsing.
- **Cursor**: one hermetic single-shot `Agent.prompt` (settingSources `[]`), JSON parsed
  leniently from the text.
- **Vega**: no local judge execution; attached judges are skipped with a log note.

The graph walker invokes an optional `judgeHook` after each node completes, passing the node's
prompt, output, and tracker; the hook resolves attached judges via `aiClient.judgeConfig()`
(with the same interpolation variables the agents get) and records sampled results. Judge
failures record a failed evaluation but never fail the chain.

**Consequences.**
- Each sampled evaluation is one extra LLM call per judged node (~2/PR at samplingRate 1) —
  acceptable at prototype volume; the rate is an LD-side dial per variation.
- **Judge instructions are part of the measurement instrument**: editing them breaks
  cross-time comparability of scores. Treat judge edits like schema changes (CHANGELOG them).
- Judge scores must stay evaluation-only. If a score ever needs to gate the chain, that's a
  routing-tag/reviewer change, not a judge change — keep the gate/evaluator separation.
- Field-name quirk: the management API stores attachments as `judgeConfigKey`; the SDK type
  says `key`. The hook accepts both.
- The Cursor extension front end does not wire the hook yet (judges run in the GHA path).
  *(Update 2026-07-07: the judge configs + attachments are now committed under
  `config/agentcontrol/` and provisioned by bootstrap — fresh installs get judging out of
  the box. The provisioner re-attaches `judgeConfiguration` via a follow-up variation
  PATCH, because the create-config endpoint's inline `defaultVariation` drops it.)*
