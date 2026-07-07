# shared

The core of the prototype — the agent-execution seam and everything the other
packages build on. If you're looking for the customization points, they're here.

## Module map

| File | Purpose |
|------|---------|
| `src/agentRunner.ts` | The **provider seam**: `AgentRunner` interface + neutral request/result types the graph walker codes against |
| `src/anthropic/anthropicAgentRunner.ts` | Default backend: a local Anthropic tool-use loop driving each node |
| `src/anthropic/sandboxTools.ts` | Capability-gated agent tools (read/list/grep/git_diff; create_flag/edit_file/commit_and_push) — the security boundary for agent file access |
| `src/anthropic/ldWriter.ts` | Real flag creation against the app project (409 → already-exists) |
| `src/cursor/cursorAgentRunner.ts` | Cursor backend: runs each node as a Cursor agent via `@cursor/sdk` (lazy-loaded), reusing the sandbox tools as Cursor `customTools` |
| `src/cursor/cursorModel.ts` | Maps the LD AI config's model name + parameters onto a Cursor model selection (exact → fuzzy → `CURSOR_MODEL` fallback) |
| `src/judges.ts` | LaunchDarkly judge execution: `createJudgeHook` runs judges attached to a node's AI config (SDK `Judge` class over a provider-supplied completion) and records scores on the node's tracker |
| `src/judgeEvidence.ts` | Ground truth for judges: node-scoped `git diff` of exactly the commits the judged agent landed (HEAD-snapshot collector) |
| `src/anthropic/judgeCompletion.ts` | Anthropic judge execution: one forced-tool-use completion returning `{score, reasoning}` |
| `src/cursor/judgeCompletion.ts` | Cursor judge execution: hermetic one-shot `Agent.prompt` + lenient JSON extraction |
| `src/vegaAgentRunner.ts` | Alternative backend: thin adapter over the Vega client |
| `src/vegaClient.ts` / `src/vegaTransport.ts` | Vega dispatch: client polls to terminal; `GraphQLVegaTransport` is the real impl, `StubVegaTransport` the no-config fallback |
| `src/ldSdk.ts` | Native LaunchDarkly bootstrap: server SDK (flag eval) + AI SDK (configs/graphs/trackers) + the pipeline context |
| `src/providerFlag.ts` | Resolves `auto-factory-ai-provider` (default `anthropic`) via the server SDK |
| `src/ldClient.ts` | REST client (configurable base URL) for flags, metrics, AI configs, graphs |
| `src/releaseAdapter.ts` | Phase 2 release API: `startAutomatedRelease`, `getReleasePolicy`, `normalizeReleasePolicy` |
| `src/env.ts` | `.env` loader + `targetConnection` / `appConnection` / `sourceConnection` |
| `src/config.ts` | Schemas for the YAML files under `config/` |
| `src/types.ts` | Common types (approval modes, release shapes, release-flag file) |

## Customization seams

- **Add a provider:** implement `AgentRunner` and wire it into the action's
  `createAgentRunner` (see [ADR 0005](../../docs/adr/0005-provider-seam-local-anthropic-execution.md)
  for the seam, and [ADR 0006](../../docs/adr/0006-cursor-sdk-provider.md) for the Cursor backend as
  a worked example — model mapping, custom-tool reuse, lazy SDK load).
- **Change agent capabilities:** `sandboxTools.ts` (note the known config-key
  coupling in `anthropicAgentRunner.ts` — CLEANUP #24).
- **Point at a different LD instance/project:** env vars consumed by `env.ts`.
