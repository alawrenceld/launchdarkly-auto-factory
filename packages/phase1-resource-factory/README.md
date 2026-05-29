# phase1-resource-factory

Phase 1 integration glue. **The agents themselves run on LaunchDarkly's hosted
runtime** — this package does not contain an agent loop. It assembles PR context,
calls the LD agent API, and acts on the result.

| Dir | Purpose |
|-----|---------|
| `github-action/` | Assemble PR context (diff, files, metadata), call the LD agent API, handle the result |
| `agents/` | Local **sanitized copies** of each agent's instructions (the canonical source is provisioned by `config-bridge`) |
| `approval/` | Read the approval **mode** from a LaunchDarkly flag (per-repo) and apply or gate accordingly |
| `adapters/ci-github/` | Read the PR; post checks/comments; deliver code changes |
| `adapters/ld/` | Create flags & metrics with **idempotent upsert** (re-runs are no-ops) |

## Agent graph (sequential)

```
Research & Planning   ── triage: does this PR need a flag? + compute risk score
   │ no flag ─▶ STOP (downstream agents never run)
   ▼ yes
Flagging  ─▶  Metrics  ─▶  Testing  ─▶  Code Review  ─▶  APPROVE / REJECT
```

`Flagging → Metrics` is sequential: Metrics consumes the flag key created by
Flagging via the graph handoff.

## Approval modes (default: Yolo)

- **Yolo** — auto-apply everything Review approves.
- **Middle** — gate on the risk score (thresholds TBD).
- **Manual** — human approves every approved change (in GitHub).
