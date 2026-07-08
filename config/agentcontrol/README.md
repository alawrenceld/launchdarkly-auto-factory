# config/agentcontrol

The customization surface for the agents: each agent's instructions and the
shape of the agent graph (root, nodes, edges/handoffs). These are what the
`config-bridge` provisions into a LaunchDarkly project (`npm run bootstrap`).

Editing these is the supported way to tune, add, split, or reorder agents
without touching code.

## ai-configs/

One JSON file per agent, in the shape `provision` consumes
(`key`, `name`, `description`, `mode`, `tags`, `variations`). These are the
canonical public copies of the five agents:

| File | Chain position | Role |
|------|----------------|------|
| `autofactory-research-planner.json` | 1 | classify the PR, produce the implementation brief |
| `autofactory-flag-implementer.json` | 2 | create the flag (targeting off), wire the code |
| `autofactory-metrics-author.json` | 3 | create guarded-release metrics, instrument events, write the manifest |
| `autofactory-flag-testing.json` | 4 | flag-on/flag-off tests, run to green |
| `autofactory-code-reviewer.json` | 5 | independent verdict + risk level |

Only the `default` variation (the Anthropic tool-use surface, on
`claude-sonnet-4-6`) is committed. The live prototype project also carries
per-provider/per-model variations (e.g. a Vega runtime variant, and a Composer
variation on the coding agents for the Cursor A/B); those are not committed here —
the Composer variation waits on Composer becoming a built-in LD model.

The two **judge** configs (`autofactory-judge-implementation-quality`,
`autofactory-judge-metrics-quality`, mode `judge`, ADR 0007) ARE committed here and
provisioned by bootstrap, including their `judgeConfiguration` attachments on the
flag-implementer / metrics-author `default` variations — so a fresh install gets
evidence-based judging out of the box. Judge-instruction edits reset score
comparability — log them in the CHANGELOG.

Two-way convention: after provisioning, instructions are editable in the
LaunchDarkly UI and take effect on the next run. If you change them in LD,
re-export to these files so the repo stays canonical, and log the change in
`CHANGELOG.md`.

## graphs/

`auto-factory.json` defines the chain: root config, edge order, routing
conditions, and per-agent write capabilities. Note that the **action resolves
the graph live from LaunchDarkly at run time**; this file is what gets
provisioned, not what gets executed, so graph changes must be made in LD (or
re-provisioned into a fresh project) to take effect.

## Canonical agent tags

Agents drive routing and approval by emitting tags (via `tag_conversation`).
These are the canonical keys the pipeline reads; emit exactly these. The
machine-readable source of truth is [`tags.json`](tags.json) (producer, how it's
produced, consuming edges) — `npm run check:configs` enforces that this table,
the registry, the graph, and the instructions all agree.

| Tag | Set by | Meaning |
|-----|--------|---------|
| `skip_flagging` | research-planner | `"true"`: this PR needs no flag (short-circuits the chain) |
| `flag_worthy` | research-planner | the planner's flag-worthiness recommendation; advisory (no edge consumes it), but always recorded |
| `flag_created` | flag-implementer | `"true"`: a flag was created (set automatically by `create_flag`) |
| `flag_key` | flag-implementer | the created flag's key (set automatically by `create_flag`) |
| `needs_tests` | metrics-author | `"true"`: route to the testing agent |
| `review_approved` | code-reviewer | `"approve"`/`"approved"`/`"true"`: the change is approved |
| `metrics_created` | metrics-author | `"true"` if any metric was created/reused (set automatically by `create_metric`) |
| `metric_keys` | metrics-author | comma-separated metric keys attached (set automatically by `create_metric`) |
| `risk_level` | code-reviewer | `low` / `medium` / `high`; categorical companion to `risk_score` (fallback mapping when the score is missing) |
| `risk_score` | research-planner | numeric `0.0`–`1.0`; in `risk-threshold` approval mode, steps gate when it meets the `auto-factory-risk-threshold` flag (fail-closed when absent) |

`interpretWalk` (`packages/shared/src/approval.ts`) reads
`review_approved` / `risk_level` first and accepts a few legacy keys
(`review_decision`/`decision`/`approved`, `risk`) only as fallbacks.

## Handoff fields the walker honors

Each graph edge's `handoff` object may carry: `require_tags`, `skip_if_tags`,
`max_turns`, `request_type`, and `capabilities`.

`capabilities` is a string array granting the **target** node tool access on the
Anthropic provider:

- `"create_flag"`: real boolean flag creation in the app project.
- `"create_metric"`: real guarded-release metric creation in the app project
  (off a custom event the agent instruments with `track()`).
- `"edit_files"`: `write_file` / `edit_file` / `run_tests` / `commit_and_push`.

Put grants here so "which agent can write" is config, not code. When an edge
omits `capabilities`, the runner falls back to a built-in per-config-key map
(`autofactory-flag-implementer`: create_flag+edit_files,
`autofactory-flag-testing`: edit_files, `autofactory-metrics-author`:
create_metric+edit_files); everything else is read-only. Grants are always
intersected with the global `ENABLE_FLAG_CREATION` / `ENABLE_CODE_CHANGES`
toggles.

## Naming convention

Prose form is **AutoFactory**. New resource keys use the `autofactory-` prefix
for AI configs and `auto-factory-` for flags. Existing live LD resources are not
renamed.

## Changelog

Changes to the AI configs, the agent graph, or operational flags are logged in
`CHANGELOG.md` (this directory).
