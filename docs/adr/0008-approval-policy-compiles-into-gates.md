# ADR 0008 — Approvals: three flags compiled into pre-execution gates

**Status:** accepted (2026-07-08). Supersedes the post-hoc approval modes (yolo/middle/manual).

**Context.** An audit found the approval mechanisms had drifted into theater: the
yolo/middle/manual mode was an env var (never the planned flag), evaluated *after* the walk —
by which point the flags existed and the commits were pushed, so "requires human" printed a
message with no mechanism behind it. The only working approval surface was the per-step gates
flag (pre-execution halt, PR-label resume). Risk was a categorical tag consumed solely by that
post-hoc theater.

**Decision.** Approval policy is three LaunchDarkly flags, each answering one question, that
**compile into pre-execution gates** — the one mechanism that actually withholds side effects:

| Flag | Question | Values |
|------|----------|--------|
| `auto-factory-approval-mode` | whether | `yolo` (default) · `risk-threshold` · `always` |
| `auto-factory-risk-threshold` | how sensitive | 0–1 (default 0.6) |
| `auto-factory-approval-gates` | where | node keys; `{step, threshold}` entries override per step |

Compilation (`shared/approvalPolicy.ts`): yolo → no gates; always → gate the configured steps;
risk-threshold → gate a step when the research planner's numeric `risk_score` (0–1, forced on
every run via NODE_REQUIRED_TAGS) ≥ the step's threshold (per-step override, else blanket).
The walker passes accumulated tags to `GateController.resolve`, so gates are risk-conditional
at exactly the right time — the planner runs first, so its score exists before any gate is
checked. **Fail-closed:** unknown/unparsable risk gates the step. A non-yolo mode with no
configured steps defaults to gating `autofactory-flag-implementer` ("approve before anything
is created"); the gates flag itself carries no empty variations — yolo is the bypass.

`decideApproval` is now verdict-only reporting (approve/reject/no-op/incomplete). The
post-hoc `requiresHuman` outcome is gone. Env overrides remain for local runs
(`APPROVAL_MODE`, with legacy `middle`/`manual` mapped; `RISK_THRESHOLD`; `APPROVAL_GATES`),
and the workflow templates no longer hardcode a mode — the flags are the control plane.

**Consequences.**
- Middle-mode's promise is finally real: risk-gated approval happens *before* the risky step
  runs, and the planner's risk signal has its first real consumer.
- An LLM's `risk_score` is a tuning dial, not a calibrated probability — the planner's
  instructions anchor the scale (~0.2 additive / ~0.5 business logic / ~0.8 cross-cutting,
  auth, payments, migrations), and the threshold is meant to be tuned against observed runs.
- Per-step thresholds ship as a forward-compatible *shape* in the gates flag; the blanket
  threshold is the intended day-one surface.
- The reviewer's `risk_level` remains as the categorical companion (and fallback mapping
  low=.25/medium=.5/high=.75) — approval no longer reads it post-hoc.
