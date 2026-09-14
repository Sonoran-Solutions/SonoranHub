# Initial Backlog

This backlog translates the roadmap into reasonably bounded implementation tasks. It is intentionally biased toward foundations and vertical slices over breadth.

Statuses are not tracked here once active development begins; use GitHub Issues/Projects for live work. This document defines the initial decomposition and dependency order.

## Priority legend

- **P0** — required for the first end-to-end MVP loop.
- **P1** — high-value immediately after the vertical slice.
- **P2** — useful later; should not distract from MVP.

---

# Epic A — Monorepo foundation

## A1 — Scaffold pnpm monorepo [P0]

Create:

```text
apps/web
apps/api
apps/agent
packages/contracts
packages/ai-capacity
```

Add root workspace scripts for install/build/typecheck/test/lint.

**Acceptance**

- `pnpm install` succeeds from a clean clone.
- `pnpm build`, `pnpm typecheck`, and `pnpm test` run from root.
- TypeScript is strict.
- No production feature logic beyond scaffolding.

## A2 — Add CI [P0]

GitHub Actions workflow for install, typecheck, test, lint, and build.

**Acceptance**

- Runs on PRs and pushes to default branch.
- Dependency caching configured sanely.
- No secrets required for baseline CI.

## A3 — Shared configuration/logging conventions [P0]

Add environment validation, structured logger interface, correlation IDs, `.env.example`, and secret-safe logging guidance in code.

---

# Epic B — Shared contracts

## B1 — Capacity contracts [P0]

Implement schemas/types from `AI_CAPACITY.md`.

**Acceptance**

- Fixture tests for wallet, rolling quota, weekly quota, pricing window, and unknown/stale state.
- Invalid percentages/units/timestamps rejected.

## B2 — Machine and Agent contracts [P0]

Define:

- Agent hello/registration metadata;
- heartbeat;
- capability advertisement;
- machine status;
- telemetry summary.

## B3 — Task/Run contracts [P0]

Define Task, Run, RunEvent, state enums, and transition helpers/tests.

**Acceptance**

- Task and Run remain separate entities.
- Illegal terminal-state transitions are tested.

## B4 — Remote action contract [P0]

Define typed request/result envelopes including request ID, target machine, issued/expiry timestamps, and capability identifier.

No arbitrary shell-command payload.

---

# Epic C — Web/API shell

## C1 — Responsive application shell [P0]

Create routes:

```text
/
/capacity
/projects
/tasks
/machines
/ideas
/settings
```

Use placeholder data only.

**Acceptance**

- Usable at narrow Android phone/Fold viewport widths.
- Desktop uses available space rather than stretching a mobile layout.
- Navigation works with keyboard and touch.

## C2 — API skeleton [P0]

Fastify service with:

- health/readiness endpoints;
- request IDs;
- structured errors;
- typed client boundary.

## C3 — Database foundation [P0]

PostgreSQL connection/migrations and initial tables needed for capacity snapshots and machine records.

Do not build the entire future schema in the first migration.

---

# Epic D — AI Capacity

## D1 — Provider adapter framework [P0]

Implement adapter registry, probe/collect lifecycle, typed errors, refresh scheduler, and independent provider health.

**Acceptance**

- One adapter can fail without aborting another.
- Last known successful values can be returned as stale.

**Status:** Completed for the initial OpenRouter/DeepSeek slice, including the
generic probe/collection refresh semantics correction.

## D2 — OpenRouter adapter [P0]

Collect current key/account usage and budget/credit resources available to configured credentials.

**Acceptance**

- Official endpoint responses are covered by fixture tests.
- Missing optional limits are represented as missing, not zero.
- Secrets are redacted from logs/errors.

## D3 — DeepSeek balance adapter [P0]

Collect official DeepSeek balance as wallet resources.

## D4 — DeepSeek pricing-window engine [P0]

Implement peak/off-peak schedule and next transition from versioned config.

Reference: https://github.com/FAAATQ/DeepSeekBudget

**Acceptance**

- Boundary tests immediately before/at/after every schedule transition.
- Weekday/weekend behavior tested.
- Pricing config includes source/verification metadata.
- If source code is adapted from DeepSeekBudget, required MIT attribution is included.

## D5 — Persist capacity snapshots [P0]

Store normalized snapshot + collection metadata.

**Status:** Completed with the Capacity-specific PostgreSQL store, migration,
bounded latest/history queries, and integration-test path.

## D6 — Capacity dashboard [P0]

Show OpenRouter and DeepSeek live data, freshness, collector error state, and next reset/price change.

**Status:** Completed for the first `/capacity` view and compact home summary.

## D7 — ChatGPT/Codex capacity adapter [P1]

Implement Agent-side integration with locally authenticated Codex app-server behind a versioned adapter.

**Acceptance**

- Hub does not receive reusable ChatGPT auth token.
- Primary/secondary windows normalize independently.
- Integration failure produces stale/unknown state rather than false zero.

## D8 — Gemini capacity adapter [P1]

Implement the most reliable available official/local source behind `GeminiCapacitySource`.

Mark experimental parsing explicitly if unavoidable.

## D9 — Capacity history/burn rate [P1]

Add trend charts and derived “likely to exhaust before reset” signal after sufficient real snapshots exist.

---

# Epic E — Sonoran Agent foundation

## E1 — Agent config and machine identity [P0]

Create Agent config format, stable machine ID, version reporting, and protected state directory.

## E2 — Agent authenticated connection [P0]

Outbound WebSocket connection, handshake, heartbeat, reconnect/backoff, protocol version negotiation.

## E3 — Local capability policy [P0]

Parse/validate local machine capability configuration and advertise effective capabilities.

**Acceptance**

- Unknown capability rejected.
- Hub cannot override locally denied capability.

## E4 — Basic telemetry [P0]

CPU, memory, uptime, configured disks. GPU support may be best-effort/plugin-based.

## E5 — Machine dashboard [P0]

Online/stale/offline, last heartbeat, telemetry, Agent version, capabilities.

## E6 — Safe remote action proof [P0]

Implement one configured service/process action plus one read-only repository action.

Every write action creates an audit event.

---

# Epic F — GitHub/project plane

## F1 — GitHub integration configuration [P0]

Use a GitHub App/integration with minimum required permissions.

## F2 — Project/repository model [P0]

Hub project points to one or more GitHub repositories.

## F3 — Project cockpit [P0]

Display branch/PR/issue/CI attention summary.

## F4 — GitHub webhook ingestion [P1]

Verify signatures, normalize events, update project state.

---

# Epic G — Task execution vertical slice

## G1 — Task create/edit UI/API [P0]

Capture goal, context, constraints, acceptance criteria, repo/base, execution profile, and risk.

## G2 — Run creation/dispatch [P0]

Create immutable Run attempt under Task and target a connected Agent.

## G3 — Repository allowlist [P0]

Agent maps logical repository ID to local allowed path/remote. Reject arbitrary paths from Hub.

## G4 — Worktree lifecycle [P0]

Create unique branch/worktree and journal its initial state.

## G5 — Worker adapter interface [P0]

Implement generic adapter contract plus one real worker implementation.

## G6 — Structured execution events [P0]

Stream high-level states plus separately retrievable bounded logs.

## G7 — Acceptance-check runner [P0]

Run repository-configured checks after worker completion and normalize results.

## G8 — Result/review screen [P0]

Show summary, files changed, check results, risks, branch, artifacts, and PR link.

## G9 — PR creation [P0]

Create PR only when task/run policy requests it; do not auto-merge.

**Epic exit condition:** complete one real coding task from phone to PR without SSH/manual terminal intervention.

---

# Epic H — Orchestrator

## H1 — Execution/model profile configuration [P1]

Profiles define worker adapter, model/provider, effort, timeouts, capability needs, and cost/quota metadata.

## H2 — Rule-based task classifier [P1]

Classify task type/difficulty/risk into routing signals. Keep output inspectable and overrideable.

## H3 — Capacity-aware router [P1]

Combine model suitability with quota, reset time, balance, and pricing window.

## H4 — Routing explanation/persistence [P1]

Store selected profile, alternatives, inputs, and reasons.

## H5 — Escalation/evidence bundle [P1]

Create a normalized evidence bundle from prior Runs containing findings, logs/check summaries, changed files, and blockers. A stronger model should consume this rather than restart investigation blind.

## H6 — Review run [P1]

Support independent second-model review as its own Run type.

---

# Epic I — Ideas / ThoughtRouter integration

## I1 — Quick-capture inbox [P1]

One-field mobile-first capture that persists raw text immediately.

## I2 — Idea classification/linking [P1]

Suggest project/category without destroying raw input.

## I3 — Promote idea [P1]

Convert to Task, GitHub issue, research request, or project brief.

---

# Epic J — Advanced operations and analytics

## J1 — Local model lifecycle [P2]

Configured model server status/start/stop/unload controls.

## J2 — Process manager [P2]

Richer allowlisted process view/actions.

## J3 — Restricted terminal [P2]

Only if typed actions prove insufficient. Must have a separate security review.

## J4 — Remote desktop integration [P2]

Launch/deep-link an established remote desktop solution; do not build a custom protocol first.

## J5 — Model performance analytics [P2]

Compare completion, retry, review-rejection, cost, duration, and test-success metrics by profile.

---

# Recommended first ten coding tickets

If using coding agents, create these as separate GitHub issues/PRs rather than one huge implementation session:

1. **A1:** pnpm monorepo scaffold.
2. **A2:** CI baseline.
3. **B1:** capacity contracts + tests.
4. **B2/B3:** machine/task/run contracts + tests.
5. **C1:** responsive UI shell.
6. **C2:** Fastify API + typed health client.
7. **D1:** capacity adapter framework.
8. **D2:** OpenRouter collector.
9. **D3/D4:** DeepSeek balance + pricing schedule.
10. **D5/D6:** persistence + first real Capacity dashboard.

After ticket 10, stop and review architecture/UX before starting the Agent. The capacity subsystem will provide real data and expose whether the initial contracts are pleasant to use.

# Agent task template

When handing one of these tasks to a coding model, use a task brief shaped like:

```text
Goal
<one bounded outcome>

Read first
- README.md
- relevant docs/*.md
- existing code/tests in affected package

Constraints
- do not expand scope without documenting why
- preserve provider/worker adapter boundaries
- do not commit secrets
- do not weaken Agent capability checks

Acceptance criteria
- <observable criteria>

Validation
- tests
- typecheck
- lint/build as relevant
- git diff --check

Output
- summarize changes
- list validation run/results
- identify remaining risks or follow-ups
```

The coding model should be asked to stop and report evidence when blocked rather than papering over an unknown protocol/provider behavior with guessed constants.
