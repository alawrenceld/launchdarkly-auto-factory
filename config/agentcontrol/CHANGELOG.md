# AutoFactory Agent Config & Graph — Change Log

Running log of changes to the AutoFactory **AI configs** (`autofactory-*`), the
**agent graph** (`gha-auto-factory`), and the **operational flags** that drive the
pipeline. These resources live in LaunchDarkly (the factory / control-plane project
`auto-factory-prototype`), not as files in this repo — this file is the
human-readable record of what changed there and why.

> Out of scope: agent *runtime* changes (the action's tools — `git_diff`,
> `create_flag`, `write_file`/`edit_file`/`run_tests`/`commit_and_push` — and the
> approval logic) live in the code repo / its PRs. They're referenced here only
> where they explain a config change.

Status legend: ✅ done · 🔜 planned/in progress

---

## 2026-06-09

### ✅ (cleanup) Dropped inert `prompt_template` from the committed graph copy
- **Change:** Removed `"prompt_template": "{{PR_NUMBER}}"` from every edge of the
  committed `graphs/auto-factory.json`. The graph walker owns prompt construction
  for **every** provider (it never forwards `prompt_template` to Vega), so the field
  was inert. Documented the handoff fields the walker DOES honor (`require_tags`,
  `skip_if_tags`, `max_turns`, `request_type`) in this directory's README.
- **Note:** this only touched the committed local copy. The live LD graph may still
  carry the field; it's harmless (inert) but can be removed there too. See CLEANUP #28.

### ✅ (cleanup) Edge-declared agent `capabilities` (config-driven write access)
- **Change:** Added a `capabilities` array to two edges of the committed
  `graphs/auto-factory.json`: the edge into `autofactory-flag-implementer` grants
  `["create_flag", "edit_files"]`, the edge into `autofactory-flag-testing` grants
  `["edit_files"]`. The Anthropic runner reads these instead of a hardcoded
  config-key map (which it keeps only as a fallback). Always intersected with the
  global `ENABLE_FLAG_CREATION` / `ENABLE_CODE_CHANGES` toggles.
- **Why:** "which agent can write" should be config, not code — a renamed/added
  agent no longer silently lands read-only. See CLEANUP #24. To take effect on the
  Vega-seeded path, add the same `capabilities` to the live LD graph's edges.

### ✅ 0. Provider-selection flag (`auto-factory-ai-provider`) — foundational
- **Change:** Created a multivariate string flag in the factory project: variations
  `anthropic` / `vega` (extensible to other providers), **default `anthropic`**.
- **What it does:** the Phase 1 runtime evaluates it (server SDK) to pick the agent
  execution backend — run the chain locally on the Anthropic API, or dispatch to Vega.
  Flip it in LaunchDarkly to switch; no code/workflow change needed.
- **Why:** decouples "which AI runs the agents" from the pipeline so we can move off
  Vega without losing it, and swap providers later.

### ✅ 1. Added the Metrics Author agent + rewired the graph
- **Change:** Added `autofactory-metrics-author` as a core node in the chain and
  rewired `gha-auto-factory` to:
  `research-planner → flag-implementer → metrics-author → flag-testing → code-reviewer`.
- **Handoff conditions:** flag-implementer → metrics-author requires `flag_created=true`;
  metrics-author → flag-testing requires `needs_tests=true`.
- **Why:** The release pipeline needs metrics authored for guarded releases; the
  metrics step belongs between flag creation and testing.

### ✅ 2. Increased the Code Reviewer turn budget
- **Change:** Raised `max_turns` on the `flag-testing → code-reviewer` edge handoff
  to **30** (verified live).
- **Note:** An earlier attempt to set this to 25 did **not** persist — the live
  graph was still 15 when checked on 2026-06-09, which is why the reviewer kept
  running out of turns. Now confirmed at 30 via full-object REST PATCH.
- **Why:** The reviewer was hitting its turn cap before reaching a verdict. (Turns
  are a cushion; the real cause was the reviewer being unable to see the diff —
  see #4.)

### ✅ 3. Test agent (`autofactory-flag-testing`) — de-scoped + execute (v2)
- **Changes applied** (variation `default` → version 2):
  1. **Explicit execution:** "generate tests" → "use `write_file`/`edit_file` to
     create the test file(s), then `commit_and_push` once. Do NOT merely
     describe/design the tests."
  2. **De-scoped to flagged behavior only:** removed ROLE 1 (general coverage for
     all modified production code — rules T03/T04/T21–T25 and skip-conditions
     T14/T15). The agent now writes ONLY flag-on/flag-off tests for the code paths
     the flag-implementer wrapped (rules T01/T02/T08/T12/T13).
  3. **(Extra) Repo-adaptive test conventions:** replaced the hardcoded internal-monorepo
     Go/TypeScript patterns (`testify`, `@internal/testing`, Vitest, the
     `T26/T27` framework constraints, `/app/run_validation.sh`) with "detect and
     follow the repo's existing framework; else the language's standard (e.g.
     pytest for Python)." Needed because the demo app is Python/Flask — the
     internal-monorepo-only patterns would have produced Go/TS tests for Python code.
- **Why:** The agent has write + push tools now (PR
  launchdarkly-labs/launchdarkly-auto-factory#1, merged), but on demo PR #3 it
  described tests instead of creating them, and its scope/patterns were wrong for
  the target repo.
- **Follow-up (version 4):** switched its diff reference to the new `git_diff` tool
  (it has no shell) and reworded "Validation" to acknowledge it cannot execute
  tests (no bash) — verify test files are syntactically valid instead.

### ✅ 4. Code Reviewer (`autofactory-code-reviewer`) — let it SEE the diff (v2)
- **Root cause (not turns):** the reviewer was told to run `gh pr diff` / use
  `Bash`, but in our runtime it has **no shell, bash, or gh** — only read-only file
  tools. So it couldn't see the change set and burned all its turns reading files
  one-by-one to infer the diff, never reaching a verdict.
- **Changes applied** (variation `default` → version 2):
  1. Added a read-only **`git_diff`** tool to the agent runtime (shared sandbox
     tools; available to all nodes). Wired `pr_base` through the action/workflow so
     it diffs `base...HEAD`.
  2. Reviewer instructions: call **`git_diff` FIRST** to see the full change set
     (incl. agent enrichment commits), then read specific files. Aligned tool names
     (`Read`/`Glob`/`Bash`/`gh pr diff` → `read_file`/`list_dir`/`grep`/`git_diff`)
     and stated it has no shell access.
  3. Verdict stays **last** (step 5): analyze, then emit `review_approved` /
     `risk_level`. (We explicitly did NOT adopt "verdict first" — a verdict should
     follow the analysis, not precede it.)
- **Why:** Treat the cause (can't see the diff), not the symptom (turn cap). Turns
  raised to 30 (see #2) as a secondary cushion.
- **Validated:** demo PR #4 (`/api/quote`) — reviewer ran to completion, called
  `git_diff`, and returned an accurate verdict (REJECT, 2 BLOCKING) catching a real
  test/impl mismatch. See #5.

### ✅ 5. Flag Implementer (`autofactory-flag-implementer`) — tool-accurate cleanup (v2), fail-safe reverted (v3)
- **Tool/pattern cleanup (v2, still in effect):**
  - Removed the internal-monorepo-specific SDK-helper patterns (`createFlagFunction` /
    `@internal/dogfood-flags`, `flagfn.NewBool` / `OnErrorLogAsError`), the
    `make go-generate` "Code Generation" section, and the `/app/run_validation.sh`
    "Validation" step — none apply in this runtime. Replaced with "match the repo's
    existing flag pattern."
  - Swapped `ldcli flags create` → the in-runtime `create_flag` tool, and push →
    `commit_and_push`. NOTE: `ldcli` is LaunchDarkly's official CLI (not an internal tool) —
    this was a swap to our current tool, not a "fix." See backlog below.
- **Fail-safe Task #3 — ADDED in v2, then REVERTED in v3 (decision "(a)"):** v2 had
  added "flag evaluation must FAIL SAFE … harden the shared helper" to keep the code
  consistent with the testing agent's resilience tests. We reverted it because:
  (1) LaunchDarkly's server SDK `variation()` is **already fail-safe by design**
  (returns the default on error, doesn't throw), so the PR #4 resilience test was
  over-specified; (2) the implementer wasn't honoring the instruction anyway (PR #5/#7
  left `_flag()` unhardened). We rely on the SDK's built-in fail-safe rather than imply
  defensive behavior we don't enforce. The testing agent only writes flag-on/flag-off
  tests now, so there's no test/impl conflict to reconcile. Current Task #3 is just
  "preserve existing behavior on the control path."

### ✅ 6. `run_tests` tool — testing agent runs what it writes (testing v5)
- **Change:** Added a `run_tests` agent tool (auto-detects pytest / `npm test` / `go test`,
  installs deps, returns pass/fail output), available to the edit-capable nodes. Testing
  agent → **version 5**: write tests → `run_tests` → fix failures (imports, fixtures,
  assertions) → only `commit_and_push` once green. Added guidance to ensure imports
  resolve for how the runner is invoked (module path / `conftest.py`).
- **Why:** The testing agent wrote tests it couldn't execute (no shell), so import/path
  errors slipped through on every run and the reviewer (correctly) blocked them — PR #4
  (test/impl fail-safe mismatch) and PR #5 (`from app import …` module-path error). Same
  shape as the `git_diff` fix: give the agent the ability to verify its own output. This
  is real code execution in the CI sandbox — the capability expansion we'd deliberately
  deferred until now.

### 🔜 Backlog — consider `ldcli` for flag creation
- Today the implementer creates flags via the REST-backed `create_flag` tool. Using
  LaunchDarkly's official CLI (`ldcli`) may be more efficient/idiomatic long-term.
  Revisit once the core chain is stable. (https://launchdarkly.com/docs/home/getting-started/ldcli)
