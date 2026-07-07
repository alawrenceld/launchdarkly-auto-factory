# phase1-resource-factory

The Phase 1 GitHub Action. On a pull request it resolves the agent graph from
LaunchDarkly, walks it through the selected provider, and applies an approval
decision — posting a summary comment back to the PR.

Execution is provider-agnostic (see [ADR 0005](../../docs/adr/0005-provider-seam-local-anthropic-execution.md)
and [ADR 0006](../../docs/adr/0006-cursor-sdk-provider.md)): the
`auto-factory-ai-provider` LaunchDarkly flag selects the backend. The **default is a
local Anthropic tool-use loop** (`@auto-factory/shared`'s `AnthropicAgentRunner` +
sandbox tools); the alternatives are LaunchDarkly-hosted **Vega** and **Cursor**
agents (`CursorAgentRunner` via `@cursor/sdk`; needs `CURSOR_API_KEY` and the
checkout+`npm ci` workflow variant, not the bare `uses:` form). Either way the LD AI
SDK resolves the configs/graph, the per-agent model is read from the AI config, and
generation metrics + a `gen_ai` LLM-observability span are recorded natively.

Judges attached to an agent's AI config in LaunchDarkly (see
[ADR 0007](../../docs/adr/0007-judges-for-coding-agents.md)) are executed by the
action after that node completes — scored against the agent's actual git diff —
on the Anthropic and Cursor providers; Vega skips them with a log note.

## Layout

This package is flat — `src/` + `action.yml`:

| File | Purpose |
|------|---------|
| `src/action.ts` | Action entrypoint: map inputs → env, init the LD SDKs, resolve provider + graph, walk, decide, comment |
| `src/graphWalker.ts` | Walk the `AgentGraphDefinition`: dispatch each node via `AgentRunner`, follow edges by handoff conditions |
| `src/approval.ts` | `decideApproval` (yolo/middle/manual) + `interpretWalk` (read verdict/risk from agent tags) |
| `src/prContext.ts` | Assemble PR context (number/title/body/repo) from the Actions environment |
| `src/comment.ts` | Post the run summary as a PR comment |
| `action.yml` | The input contract (see below) |

The agent graph itself (research-planner → flag-implementer → metrics-author →
flag-testing → code-reviewer) lives in LaunchDarkly, not here — see
`config/agentcontrol/graphs/auto-factory.json` for its shape.

## Handoff semantics

Each graph edge carries a freeform `handoff` object. The walker honors:

- `require_tags` — take the edge only if ALL listed `{key: value}` tags are present.
- `skip_if_tags` — do NOT take the edge if ALL listed tags match (e.g. research sets
  `{skip_flagging: "true"}` → the flagging edge is skipped, short-circuiting the chain).
- `max_turns` — cap on agent turns for the target node.
- `request_type` — Vega persona for the target node (informational on Anthropic).

## Approval modes (default: yolo)

Read from `APPROVAL_MODE` (env / action input) today; a per-repo LaunchDarkly
flag is planned. A rejected review never auto-applies regardless of mode.

- **yolo** — auto-apply everything the review approves.
- **middle** — auto-apply unless `risk_level` is `high` (then require a human).
- **manual** — every approved change still requires a human.

## The action bundle

`runs.main` points at `dist/action.bundle.js` (esbuild). **Any change under `src/`
must be followed by a rebuild and a commit of the bundle** — CI fails on drift:

```bash
npm run bundle -w @auto-factory/phase1-resource-factory
```

## Input contract

See `action.yml` for the full list. Inputs are exposed to the code as
`INPUT_<NAME>` and mapped to plain env vars in `mapActionInputs`; keep
`action.yml`, `mapActionInputs`, and the repo `.env.example` consistent.
