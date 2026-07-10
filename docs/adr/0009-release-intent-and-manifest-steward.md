# ADR 0009 — Release intent in the manifest, a steward node, and `bridge upgrade`

**Status:** accepted (2026-07-10).

**Context.** The release manifest (`.release-flags/pr-N.json`) carried only machine
parameters — release kind, environment — authored by agents for Beacon. Humans in the
approval loop (ADR 0008) had no structured place to say *how* a flag should ship
("hold until next month", "this depends on flag-xyz", "beta segment first"): they could
approve or reject, nothing in between. And agents wrote manifests by hand-editing JSON in
sandbox `write_file` calls, which meant a human's edits could be silently clobbered when a
gated chain resumed and re-ran from the root.

**Decision.**

1. **Two blocks with honest names.** `releasePlan` (renamed from `releaseOverrides`; legacy
   key still read and healed) is the *agent's* proposal of release mechanics. `releaseIntent`
   is the *human's* stated intent. Precedence: `releasePolicy` flag ← `releasePlan` ←
   `releaseIntent`. Intent is flat — `action` (`auto`/`hold`/`manual`), `notBefore`,
   `segments`, `prerequisites`, `releaseWith`, `reference`, `approvedBy`, and one free-text
   `notes` field — and agents pre-fill the full skeleton (blank fields included, plus an
   `_instructions` line) so a human edits a form, not a spec.

2. **The manifest is tool-owned.** A dedicated `write_manifest` tool (capability-gated per
   node, like `create_flag`) is the only writer; `write_file`/`edit_file` refuse
   `.release-flags/` paths. The tool enforces the ownership boundary in merge semantics:
   agents may *create* `releaseIntent` (the skeleton) but never update it once present —
   only the steward capability may. That makes resume-after-gate safe by construction:
   re-running the chain from the root cannot clobber what a human typed.

3. **A steward node, not a library call.** `autofactory-manifest-steward` sits between
   research and implementation in the graph — exactly where human edits land (at the gate,
   after research, before implementation). It normalizes what humans actually type
   (promote notes like "child of flag-xyz" into structured `prerequisites`, fix synonyms),
   passes the brief through unchanged, and fast no-ops on an untouched skeleton. Underneath
   it, a deterministic normalizer (`normalizeReleaseIntent`) runs in Beacon regardless —
   synonym mapping (pause→hold, ship→auto), date coercion, string prerequisites — so the
   LLM steward is an enhancement, not a dependency. **Fail-closed:** anything unintelligible
   (unknown action, unparseable date, non-object intent) normalizes to `hold`.

4. **Beacon executes what LD can express today, holds the rest.** `hold`/`manual` → held
   with the reason recorded; future `notBefore` → held; `prerequisites` → LD-native
   prerequisite wiring (semantic patch: `addPrerequisite` + `turnFlagOn` + fallthrough);
   `segments`/`releaseWith` → held and recorded. Deliberately NOT reinventing multi-phase
   staging in Beacon — LD's native multi-phase releases will own that.

5. **`bridge upgrade` is the adoption path.** `provision` is create-only, so existing
   installs could never receive changes like this one. `upgrade` = provision (create
   what's missing) + an update pass: sync existing variation `instructions` to the
   committed copies (each content PATCH followed by the no-op `modelConfigKey` re-PATCH
   that keeps cost derivation alive), attach missing `judgeConfiguration`s, and
   full-object-PATCH graphs whose root/edges drifted. It never touches flag
   variations/targeting, live model choices, or live-only variations (e.g. A/B arms) —
   that drift is reported, not fixed. `--dry-run` prints the plan.

**Consequences.**
- Approvers gain a middle option between approve and reject: approve *with intent*, and the
  intent is executed or explicitly held — never silently dropped.
- Schema is versioned (`1.1`); legacy manifests (no intent, `releaseOverrides`) keep working
  and are healed on next write.
- The intent surface is deliberately ahead of Beacon's execution: held-with-reason is the
  honest fallback until LD-native staging lands.
- Existing testers upgrade with one command instead of re-bootstrapping; the graph edge
  changes (research → steward → implementer) and instruction updates in this change are its
  first real payload.
