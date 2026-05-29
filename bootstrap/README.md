# bootstrap

The easy-setup surface. The goal: a design partner goes from clone to a working
flow with as few manual steps as possible ("simple, but not simpler").

| Item | Purpose |
|------|---------|
| `create.*` | One command: wires CI, provisions the LD env (via `config-bridge`), sets up the secrets shape, and prepares the demo |
| `github-action-template/` | Drop-in PR workflow partners copy into their repo |
| `checks/` | Preflight: tokens present, LD reachable, scopes valid — fail loudly with fixes |

**Defaults are one layer deep:** bootstrap generates real, legible config files
the partner can then edit, rather than magic that only works on the golden path.
