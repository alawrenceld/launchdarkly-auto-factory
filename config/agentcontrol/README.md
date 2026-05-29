# config/agentcontrol

The customization surface for the agents: each agent's instructions and the
shape of the Agent Graph (root, nodes, edges/handoffs). These are what the
`config-bridge` provisions into a LaunchDarkly environment.

Editing these is the supported way to tune, add, split, or reorder agents
(e.g. the Flagging/Metrics split) without touching code.
