# beacon

Phase 2 release orchestrator. Receives post-deploy notifications, discovers
newly-added release flags, routes by scope, and triggers releases. (Internally
this role is played by a Spinnaker-based tool; Beacon is the public prototype's
clean re-implementation, targeting Railway.)

| Dir | Purpose |
|-----|---------|
| `notifier/` | Post-deploy hook that POSTs the deployed SHA range to Beacon |
| `discovery/` | Diff `.release-flags/` against the deployed prod state to find new flags |
| `scope/` | Route by scope — frontend / backend / fullstack (see `config/scopes.yaml`) |
| `coordination/` | Fullstack cross-service SHA check (stateless, re-derived per notification) |
| `adapters/cd-railway/` | Trigger releases on Railway |

## Fullstack coordination

On each notification, Beacon checks whether the **other** service's
currently-deployed SHA already contains the same `.release-flags/` file. If yes,
both services have the code and the release triggers; if no, it waits for the
other pipeline's Notifier to re-evaluate.

> Open consideration (plan §8 P5): the "wait for re-eval" path needs a backstop
> (retry/timeout) so a lost notification doesn't silently strand a release.
