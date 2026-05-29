# ADR 0001 — TypeScript monorepo (npm workspaces)

**Status:** accepted

**Context.** The prototype has several deployables (config bridge, Phase 1 action, Beacon) that share
types and an LD client. The reference orchestrator (ThumbSeeker) is TypeScript/Node.

**Decision.** One TypeScript monorepo using npm workspaces, Node 20, `tsc --build` project references.
Packages: `shared`, `config-bridge`, `beacon`, `phase1-resource-factory`. The demo backend is Python
(it's a guarded app, not our tooling), the frontend is Node.

**Consequences.** Single toolchain; shared types are genuinely shared (no drift). npm workspaces avoids
requiring a non-default package manager. Trade-off: the Python demo backend is outside the workspace
(intentional — it represents partner app code).
