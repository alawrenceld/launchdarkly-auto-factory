# Open Issues / Blocked Items

Things deliberately **not built yet** because we lack the context to do them confidently. Each is
either blocked on external info or requires human judgment (sanitization, real API shapes). Built
work lives in the milestones in `docs/build-checklist.md`; this file is the "don't guess" list.

---

## BLOCKED — need real API docs

### I1. Real Vega dispatch transport
- **What:** The concrete `VegaTransport` implementation (endpoint, auth, request/response).
- **Why blocked:** The public/partner-facing Vega API is not yet documented; the reference uses
  internal-only infrastructure.
- **Built around it:** `packages/shared/src/vegaClient.ts` defines the stable interface + a
  `StubVegaTransport` that throws. The Phase 1 graph walker codes against the interface, so wiring the
  real transport is a localized change.
- **Unblock:** real Vega API docs from the team.

### I2. GitHub Action → Vega auth & secrets
- **What:** Which secrets the Phase 1 action needs and how it authenticates to Vega.
- **Why blocked:** depends on I1.

---

## NEEDS HUMAN REVIEW — sanitization / proprietary boundary

### I3. Canonical agent configs in `config/agentcontrol/`
- **What:** Sanitized, committable copies of the agent AI-configs + graph the bridge provisions.
- **Why not done:** the raw reference configs (`reference-private/phase-1/`) contain instructions that
  may reference internal tools, repos, and a prompt snippet — committing them verbatim to a **public**
  repo risks leaking internal logic/names. Sanitizing agent instructions is a judgment call, not a
  mechanical port.
- **Built around it:** the bridge reads configs from a directory (default `config/agentcontrol/`,
  overridable), so it works today against the private reference copies; the public canonical copies are
  added after review.
- **Unblock:** human review + sanitize pass of each agent's instructions.

### I4. Tool & prompt-snippet provisioning
- **What:** Provisioning the **tools** and **prompt snippets** that agent variations reference.
- **Why not done:** our snapshots contain only *references* (`{key, version}` / `{{snippet.x}}`), not
  the tool/snippet **definitions**, so they can't be recreated verbatim.
- **Current behavior:** the bridge **strips tools** and **skips snippet-dependent variations**, logging
  exactly what it dropped (matches the proven one-off behavior).
- **Unblock:** obtain tool/snippet definitions, or decide the prototype's own tool/snippet set.

---

## PACKAGING / CONVENTIONS

### I9. Agent output tag conventions
- **What:** The exact tag keys/values agents emit for the review verdict (approve/reject) and the risk
  level, which the approval step reads.
- **Status:** `interpretWalk` checks common keys (`review_decision`/`decision`/`approved`, `risk`/
  `risk_level`) as a best-effort. Confirm against the real agent configs and pin them.

### I10. Package/publish the Phase 1 action
- **What:** For `uses: <owner>/launchdarkly-auto-factory/packages/phase1-resource-factory@ref` to
  resolve, the esbuild bundle (`dist/action.bundle.js`) must be committed or the action published.
- **Status:** the bundle builds (`npm run bundle`) but isn't committed (it's gitignored build output,
  and the action can't function until Vega is wired anyway — I1). Decide commit-the-bundle vs. a release
  workflow when I1 lands.

## OPEN QUESTIONS — partial info

### I5. Reading a flag's release policy
- **What:** Where a flag's release policy (default stages/metrics/randomization unit) lives and how to
  read it, plus exact override precedence vs. `.release-flags` overrides.
- **Status:** the reference points to a `release-settings`-style endpoint; not yet confirmed against the
  target instance. Beacon currently applies `.release-flags` overrides directly; reading the underlying
  policy is the missing half.
- **Unblock:** confirm the read endpoint (likely in `reference-private/internal-apis/ld-openapi-hidden.json`).

### I6. Approval-mode flag evaluation context
- **What:** The exact LD context for the per-repo approval-mode flag (kind/key, server-side SDK vs REST
  eval), so "Yolo / Middle / Manual" can be targeted per repo.
- **Status:** the approval *logic* (apply on approve / gate on risk / require human) is buildable; the
  flag's evaluation context is the open piece. A hardcoded-config fallback covers the gap.

### I8. `previousSha` sourcing on Railway
- **What:** The Notifier needs the previously-deployed SHA so Beacon can diff
  `.release-flags/` (new = present at current SHA, absent at previous). Spinnaker provided this; Railway
  does not expose "previous deploy SHA" natively.
- **Status:** the Notifier accepts `--previous-sha` / `PREVIOUS_SHA` as an explicit input and posts it.
  How that value is produced on Railway is unresolved. Options to evaluate: (a) Beacon tracks last-seen
  SHA per service (adds state — diverges from the stateless design), (b) a Railway deploy hook that
  captures the prior active deployment, (c) compare against `main~1`.
- **Kept out of scope:** inventing a `previousSha` mechanism — flagged rather than guessed.

### I7. Demo app Railway deployment
- **What:** Validated Railway service config + deploy for the two demo services.
- **Status:** the app code + status endpoints + a Railway config can be scaffolded, but the account,
  service creation, and an actual deploy are environment-specific (the user's). Scaffold ≠ verified deploy.
