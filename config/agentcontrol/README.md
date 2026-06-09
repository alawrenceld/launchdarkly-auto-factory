# config/agentcontrol

The customization surface for the agents: each agent's instructions and the
shape of the Agent Graph (root, nodes, edges/handoffs). These are what the
`config-bridge` provisions into a LaunchDarkly environment.

Editing these is the supported way to tune, add, split, or reorder agents
(e.g. the Flagging/Metrics split) without touching code.

## Canonical agent tags

Agents drive routing + approval by emitting tags (via `tag_conversation`). These
are the canonical keys the pipeline reads — emit exactly these:

| Tag | Set by | Meaning |
|-----|--------|---------|
| `skip_flagging` | research-planner | `"true"` → this PR needs no flag (short-circuits the chain) |
| `flag_created` | flag-implementer | `"true"` → a flag was created (set automatically by `create_flag`) |
| `flag_key` | flag-implementer | the created flag's key (set automatically by `create_flag`) |
| `needs_tests` | metrics-author | `"true"` → route to the testing agent |
| `review_approved` | code-reviewer | `"approve"`/`"approved"`/`"true"` → the change is approved |
| `risk_level` | code-reviewer | `low` / `medium` / `high` — gates `middle` approval mode |

`interpretWalk` (`packages/phase1-resource-factory/src/approval.ts`) reads
`review_approved` / `risk_level` first and accepts a few legacy keys
(`review_decision`/`decision`/`approved`, `risk`) only as fallbacks.

## Handoff fields the walker honors

Each graph edge's `handoff` object may carry: `require_tags`, `skip_if_tags`,
`max_turns`, `request_type`, and `capabilities`. (Note: `prompt_template` is
**not** currently interpreted by the walker — see CLEANUP #28.)

`capabilities` is a string array granting the **target** node tool access on the
Anthropic provider: `"create_flag"` (real flag creation) and `"edit_files"`
(write/edit/run_tests/commit_and_push). Put grants here so "which agent can write"
is config, not code. When an edge omits `capabilities`, the runner falls back to a
built-in per-config-key map (`autofactory-flag-implementer` →
create_flag+edit_files, `autofactory-flag-testing` → edit_files); everything else
is read-only. Grants are always intersected with the global `ENABLE_FLAG_CREATION`
/ `ENABLE_CODE_CHANGES` toggles.

## Naming convention

Prose form is **AutoFactory**. New resource keys use the `autofactory-` prefix
for AI configs and `auto-factory-` for flags. Existing live LD resources are not
renamed.

## Changelog

Changes to the AI configs, the agent graph, or operational flags are logged in
`CHANGELOG.md` (this directory).
