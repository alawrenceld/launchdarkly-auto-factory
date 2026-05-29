# config-bridge

Provisions the agent **AgentControl configs + Agent Graphs** into a LaunchDarkly
environment. **Non-agentic** — it works over LaunchDarkly's MCP/API by pushing
local canonical copies.

| Dir | Purpose |
|-----|---------|
| `configs/` | Canonical local copies of the recommended starting configs + graphs |
| `provision/` | Populate any **target** LD env from `configs/` (setup-time) |
| `sync/` | Refresh `configs/` from any **source** instance |

Source/target instances (base URLs, project/env keys) are configured in
`config/ld-targets.yaml`; tokens come from env.

- **LD team:** `sync` from the internal instance (different, non-prod API base URL),
  then `provision` into a target env.
- **Customers:** usually skip `sync` and `provision` straight from the shipped
  `configs/` (seeded from the demo account).

Build-time detail to confirm: AI-config CRUD is on the LD MCP, but Agent Graph
CRUD may need the raw REST API. Graphs are stored locally either way.
