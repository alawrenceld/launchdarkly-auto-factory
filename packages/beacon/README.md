# beacon

Phase 2 release orchestrator. Receives post-deploy notifications, discovers
newly-added release flags, routes by scope, and triggers releases by calling the
LaunchDarkly release API **directly** (no CD-pipeline hop — see
[ADR 0002](../../docs/adr/0002-release-via-ld-api.md)).

## Layout

Flat `src/`:

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `POST /flag-releases`, `GET /health` |
| `src/notify.ts` | The `auto-factory-notify` bin — a post-deploy hook services run to POST the deployed SHA |
| `src/discovery.ts` | Diff `.release-flags/` (current vs. previous SHA) to find newly-added flags |
| `src/scope.ts` | Route by scope — frontend / backend / fullstack |
| `src/fullstack.ts` | Fullstack cross-service SHA check (stateless, re-derived per notification) |
| `src/github.ts` | GitHub Contents API client (list/read `.release-flags/` at a SHA) |
| `src/trigger.ts` | Resolve variations + rollout shape, execute via the shared release adapter |
| `src/config.ts` | Load config from the YAML files + env |

There is **no Railway adapter** — Beacon talks to LaunchDarkly's release API.

## HTTP contract

- `POST /flag-releases` — body carries `{service, environment, sha, previousSha?}`;
  authenticated with the `x-beacon-secret` header (must match `BEACON_WEBHOOK_SECRET`).
- `GET /health` — `{ ok: true }`.

## Config surface

Read from the repo `config/` dir + env:

- `config/services.yaml` — service → repo mapping.
- `config/scopes.yaml` — scope routing rules.
- `config/release-source.yaml` — where release-flag files are read from.
- Env: `BEACON_WEBHOOK_SECRET`, `BEACON_URL` (notifier), LD connection vars.

## Fullstack coordination

On each notification, Beacon checks whether the **other** service's
currently-deployed SHA already contains the same `.release-flags/` file. If yes,
both services have the code and the release triggers; if no, it waits for the
other pipeline's Notifier to re-evaluate.

> **No retry queue (prototype).** A "waiting" flag is released only when the OTHER
> service's deploy notification arrives and re-evaluates. Beacon logs each waiting
> outcome (`[beacon] WAITING: …`) with the flag, file, and service so a lost
> notification is visible. **Manual re-trigger:** once both services are deployed,
> re-POST `/flag-releases` for the service (same `sha`/`service`) to re-run discovery
> and release the now-ready flag.
