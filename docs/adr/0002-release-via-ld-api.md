# ADR 0002 — Release via the LaunchDarkly automated-release API (beta endpoints quarantined)

**Status:** accepted

**Context.** Internally, releases are executed by a CD-pipeline system invoked by the orchestrator. The
prototype uses Railway (no such pipeline system). The actual rollout is a guarded/progressive
**automated release**, driven by the `startAutomatedRelease` semantic-patch instruction and monitored
via the automated-releases endpoints — which are currently `/internal/...` and require
`LD-API-Version: beta` (mid-rename, going public).

**Decision.** Beacon calls the LaunchDarkly release API **directly**, collapsing the internal
pipeline hop. All knowledge of the beta/internal endpoints lives in one place: `releaseAdapter.ts`
(the path is a single function; the version header is set there).

**Consequences.** When the public API ships (or shape changes), only the adapter changes — Beacon is
insulated. Reading a flag's configured release policy is implemented (`getReleasePolicy` /
`normalizeReleasePolicy` in `releaseAdapter.ts`); the trigger applies precedence
**overrides > policy > demo defaults**.
