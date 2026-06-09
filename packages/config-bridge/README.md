# config-bridge

Moves the agent **AI configs + agent graphs** between LaunchDarkly projects.
**Non-agentic** — it's a CLI over the LaunchDarkly REST API (AI configs and graphs
are both REST; graph CRUD uses the raw API, handled in `provision.ts`).

## Layout

Flat `src/`:

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command dispatch: `provision` / `sync` / `seed` |
| `src/provision.ts` | Idempotent create-what's-missing into a **target** project (from a local dir) |
| `src/sync.ts` | Pull AI configs (tag- or key-filtered) + named graphs from a **source** project into a dir |
| `src/seed.ts` | `sync` from source → gitignored staging → `provision` into target, in one step |

The canonical config/graph copies live in **`config/agentcontrol/`** (not in this
package). Connections come entirely from env — `LD_*` for the target,
`LD_SOURCE_*` for the source (see `.env.example`); there is no YAML connection file.

## Commands

```bash
# Provision local copies into the target project (LD_*).
bridge provision [--ai-configs <dir>] [--graphs <dir>] [--dry-run]

# Pull from the source project (LD_SOURCE_*) into <dir> for inspection.
bridge sync --out <dir> [--tags a,b] [--graphs key1,key2]

# Plug-and-play: pull the graph(s) + the configs they reference from the source
# and provision straight into the target. No commit step (staging is gitignored).
bridge seed [--graphs key1,key2] [--staging <dir>] [--dry-run]
```

## Notes

- **Idempotency:** `provision` GETs each resource first and only creates what's
  missing (backfilling variations). Re-runs are safe.
- **Tools/snippets are stripped:** snapshots hold only references (`{key, version}`
  / `{{snippet.x}}`), not the tool/snippet definitions, so they can't be recreated
  verbatim — re-attach them in LaunchDarkly if the provider needs them.
- **Sanitization:** `sync`/`seed` pull live instructions that may carry internal
  references. `seed` keeps them in a gitignored staging dir so they never touch
  git; the **source LD project is the sanitization boundary** for the runtime path
  (see [ADR 0005](../../docs/adr/0005-provider-seam-local-anthropic-execution.md)
  and the root README's public-repo note).
