# ADR 0011 — Tool definitions live in LaunchDarkly; execution stays in the runtime

**Status:** accepted (2026-07-13).

**Context.** The agents' tools were fully code-defined: `sandboxTools.ts` held both the
model-facing interface (name, description, JSON schema) and the implementation, and
LaunchDarkly knew nothing about them. That was historical — the original hosted-runtime
provider ran tools server-side, and for local providers the definitions were born next to
their implementations — but it left the most prompt-sensitive text in the system (tool
descriptions steer agent behavior as much as instructions do) hardcoded in the repo, while
the project's whole thesis is that agent behavior is LaunchDarkly configuration.
AgentControl's tools library has since matured: definitions with schemas, per-variation
attachment, SDK exposure (`config.tools`), full REST CRUD, and per-tool invocation
tracking.

**Decision.**

1. **LaunchDarkly owns the model-facing interface.** Each sandbox tool has a definition in
   the project's tools library (key, description, schema), attached to agent variations.
   Committed copies live in `config/agentcontrol/tools/` (generated from the code registry
   by `npm run export:tools`) and are provisioned/synced by the bridge exactly like
   instructions: `provision` creates missing definitions and attachments, `upgrade` syncs
   drifted descriptions/schemas and re-points attachments at current tool versions. After
   provisioning, descriptions are editable in the LD UI and take effect next run.
2. **The runtime owns execution and the write ceiling.** Capability grants (graph edges ∩
   global toggles) still decide what CAN run, and the executor still enforces sandbox
   behavior. At run time the offering is
   `capability set ∩ implemented executors, restricted + re-described by the variation's
   attachments`: LD can narrow the set, override any description/schema, and A/B tool
   phrasing per variation — it can never broaden past the code ceiling, and an attached
   tool with no local implementation is logged and ignored, never offered as a no-op.
3. **Two deliberate exceptions.** `tag_conversation` is always offered regardless of
   attachments — the graph's routing depends on it, so a UI detach must not stall the
   chain. And a variation with NO attachments gets the full built-in defaults —
   pre-tools projects keep working unchanged.
4. **Tool invocations are tracked.** Both local runners record per-run tool usage via the
   AI SDK tracker (`trackToolCalls`), adding the tool dimension to AI Config monitoring.

**Consequences.**
- Tool descriptions join instructions and models as live, versioned, per-variation
  LaunchDarkly configuration — editable without redeploying, and A/B-able alongside the
  model comparison the judges already score.
- The security posture is unchanged: an LD edit can rephrase or remove a tool but cannot
  create write access; grants and execution remain code.
- The `[cfg:…]` drift stamp now covers the tools dir, so a stale project warns after tool
  changes like any other config change.
- Definitions exist in three places (code defaults, committed files, LD) with one rule:
  code generates the files (`export:tools` — `check:configs` guards name parity and
  attachment references), the bridge syncs files → LD, and LD is what runs. Code defaults
  only serve variations with no attachments.
- The seed path still strips tool references pulled from a source project (they point at a
  different project's library); seeded installs get tools from the committed files instead.
