# Implementation Plan

This plan is ordered around delivering a useful vertical slice early and delaying features that look impressive but do not prove the core architecture.

## Guiding rule

The first major proof should be:

> **Phone → authenticated Hub → trusted main-PC Agent → isolated coding task → structured progress → tests → branch/PR result → phone**

If a proposed feature does not help establish or harden that loop, it should usually wait.

---

## Phase 0 — Repository and engineering foundation

### Goal

Create a boring, testable monorepo and shared contracts before implementing integrations.

### Work

- Initialize pnpm workspace.
- Add TypeScript strict configuration and shared lint/format settings.
- Scaffold only the applications/packages immediately needed:
  - `apps/web`
  - `apps/api`
  - `apps/agent`
  - `packages/contracts`
  - `packages/ai-capacity`
- Set up unit-test runner.
- Add GitHub Actions for typecheck, lint, unit tests, and build.
- Add `.env.example` files without secrets.
- Establish structured logging convention with correlation IDs for task/run/agent events.
- Define initial Zod schemas for machine registration, heartbeat, capacity resource, task, run, and run event.
- Add architecture decision record (ADR) process if material implementation decisions begin changing.

### Exit criteria

- Fresh clone installs and builds with one documented command.
- CI runs on every PR.
- Web/API/Agent can import generated/shared contracts without circular dependencies.
- No provider integration or remote action is implemented before contracts exist for its output.

---

## Phase 0B — AI Capacity service

### Why this comes early

Capacity is independently useful, comparatively low-risk, and directly feeds later Orchestrator decisions. It also gives the mobile dashboard useful real data before remote execution is ready.

### Goal

Create a provider-neutral capacity model and display live data from the easiest providers first.

### Work

#### Core model

- Implement `CapacityResource` and `CapacitySnapshot` schemas.
- Support resource kinds such as:
  - `rolling_quota`
  - `weekly_quota`
  - `wallet`
  - `key_budget`
  - `pricing_window`
  - `credits`
  - `concurrency`
- Store source, collection timestamp, stale state, raw provider payload, and collector errors.
- Add polling scheduler with independent failure domains per provider.
- Add historical snapshot persistence with sensible retention/downsampling.

#### Provider 1: OpenRouter

- Read current API-key usage/budget/remaining values from official endpoints.
- Read account credit/usage data where configured credentials permit it.
- Normalize wallet/budget and daily/weekly/monthly usage without inventing missing limits.

#### Provider 2: DeepSeek

- Read official account balance.
- Implement current peak/off-peak pricing schedule.
- Treat balance and pricing window as separate resources.
- Use the DeepSeekBudget project as a design/reference source; if implementation code is copied or adapted, retain required MIT attribution and document the source.

Reference: https://github.com/FAAATQ/DeepSeekBudget

#### Provider 3: ChatGPT/Codex

- Prefer the locally authenticated official Codex app-server boundary rather than copying browser cookies/tokens into Hub.
- Implement an Agent-side collector capable of requesting structured account rate-limit state.
- Normalize primary/secondary quota windows, reset times, and available reset-credit information when exposed.
- Version-pin/document the Codex integration because the app-server protocol can evolve.

#### Provider 4: Gemini

- Put all collection logic behind a `GeminiCapacitySource` interface.
- Prefer official structured/headless data when available.
- If the initial implementation must rely on locally available Antigravity state/CLI behavior, isolate it behind the adapter and mark source confidence/staleness explicitly.
- Do not make brittle terminal-output parsing a permanent architectural dependency.

#### UI

Create an `/capacity` view and compact home cards showing:

- provider status;
- resources and units;
- remaining value/percentage when meaningful;
- reset/change time;
- stale/error state;
- last successful refresh.

### Exit criteria

- OpenRouter and DeepSeek display live data from real configured accounts.
- One provider being unavailable does not break the others.
- Capacity snapshots are persisted and can be charted historically.
- UI never labels an unavailable metric as zero.
- ChatGPT/Codex and Gemini adapters have stable interfaces even if their first collectors are still experimental.

---

## Phase 1 — Sonoran Agent and machine telemetry

### Goal

Securely establish the remote-control primitive without arbitrary shell exposure.

### Work

#### Agent identity and registration

- Generate a stable Agent/machine ID.
- Implement enrollment/bootstrap process.
- Establish an authenticated outbound WebSocket connection.
- Add protocol version and Agent version to handshake.
- Add heartbeat and reconnect with jitter/backoff.

#### Telemetry

Collect a bounded initial set:

- OS/hostname;
- uptime;
- CPU utilization;
- RAM total/used;
- disk total/used for configured volumes;
- GPU summary where a reliable platform adapter exists;
- selected process/service status.

Do not block the phase on perfect cross-platform GPU support.

#### Capability policy

Implement local capabilities before remote actions. Suggested initial groups:

- `machine.read.telemetry`
- `process.read`
- `process.stop.allowed`
- `service.read`
- `service.restart.allowed`
- `repo.read`
- `repo.test.allowed`
- `task.execute`
- `machine.reboot`
- `machine.shutdown`

The Agent advertises granted capabilities to Hub.

#### Safe actions

Implement two or three proof actions only, for example:

- run configured repository status;
- restart one explicitly configured development service;
- stop one explicitly configured non-system process.

Every action produces an audit event.

### Exit criteria

- Agent can remain connected/reconnect for an extended session.
- Hub correctly distinguishes online/stale/offline.
- Mobile can view fresh main-PC telemetry.
- At least one non-destructive remote action works end-to-end.
- An action not granted by local policy is rejected even if requested by Hub.

---

## Phase 2 — GitHub/project control plane

### Goal

Make Hub useful for navigating the existing Sonoran Solutions project portfolio without creating a duplicate source of truth.

### Work

- Implement GitHub App/integration setup.
- Discover configured organization/user repositories.
- Add `projects` that reference one or more GitHub repositories.
- Build project overview with:
  - default branch;
  - recent activity;
  - open PRs;
  - issues requiring attention;
  - latest CI/Actions state.
- Receive relevant GitHub webhooks instead of excessive polling.
- Add stable mapping between Hub task IDs and GitHub issue/PR links.
- Add explicit actions to create an issue or PR when task workflow requires it.

### Exit criteria

- Core Sonoran Solutions repos are navigable in Hub.
- PR/CI state updates promptly through webhooks/poll fallback.
- Hub does not duplicate full issue/PR bodies as independent editable truth.
- Project cockpit works on mobile.

---

## Phase 3 — Task execution vertical slice

### Goal

Prove the full remote software-development loop with one supported worker profile.

### Work

#### Task creation

Create a task form that captures:

- project/repository;
- goal;
- context/evidence;
- constraints;
- acceptance criteria;
- base branch;
- execution profile;
- risk level.

#### Agent preparation

On dispatch:

1. validate capability;
2. validate repository allowlist;
3. fetch/update base ref using configured policy;
4. create unique branch;
5. create isolated worktree;
6. write run metadata outside repository or to ignored task metadata;
7. launch worker through an execution adapter.

#### Worker adapter

Do not hard-code the system around one CLI. Define a worker interface such as:

```ts
interface WorkerAdapter {
  probe(): Promise<WorkerAvailability>;
  start(run: PreparedRun): Promise<WorkerHandle>;
  cancel(handle: WorkerHandle): Promise<void>;
  collectResult(handle: WorkerHandle): Promise<WorkerResult>;
}
```

Start with whichever local coding tool is most reliable for the existing workflow, but keep the boundary generic enough for Codex/OpenCode/other workers.

#### Progress

Publish structured status plus bounded logs.

#### Completion

After worker exit:

- capture Git status/diff summary;
- run configured acceptance checks;
- capture test output summary;
- persist resulting commit/branch state;
- optionally create a PR;
- report artifacts and risks.

### Exit criteria

From a phone on a different network, the user can create one real coding task, watch it execute on the main PC, see tests, and open the resulting branch/PR without starting a manual SSH session.

This is the **MVP vertical-slice milestone**.

---

## Phase 4 — Orchestrator and model routing

### Goal

Turn the existing Sonoran Solutions model-routing philosophy into an explainable routing engine rather than a hard-coded ladder.

### Inputs

- task type;
- estimated difficulty;
- risk;
- required capabilities/tools;
- known worker/model strengths;
- capacity resources;
- reset timing;
- API pricing/window;
- configured spend thresholds;
- historical performance;
- user overrides.

### Work

- Define configurable execution/model profiles.
- Implement rule-based router first.
- Persist every routing decision plus alternatives/reasons.
- Add capacity-preservation rules, e.g. reserve scarce premium quota below a threshold.
- Add escalation policy where a stronger model receives a structured evidence bundle from earlier attempts.
- Add second-opinion/review run type separate from implementation run.
- Add user override and “pin this profile for this task” controls.

### Do not do yet

Do not start with an ML-based router. There will not be enough clean training data. Rule-based routing plus recorded outcomes is the correct first system.

### Exit criteria

- Router can recommend a profile and explain why.
- User can override the recommendation.
- Retry/escalation creates a new Run under the same Task.
- A higher-tier model receives prior evidence without having to rediscover everything.
- Routing history is queryable for later analysis.

---

## Phase 5 — Idea capture and project planning

### Goal

Bring the ThoughtRouter concept into the same system so ideas naturally become executable project work.

### Work

- Mobile-first idea inbox.
- Store raw input immediately.
- Optional AI classification and title generation.
- Link idea to existing project or mark as candidate new project.
- Promote idea into:
  - research task;
  - implementation task;
  - GitHub issue;
  - project brief.
- Add a lightweight project-plan editor backed by files/GitHub docs rather than hiding plans only in the database.
- Add voice input if platform UX makes it worthwhile.

### Exit criteria

A random mobile thought can become a reviewed project task without copy/pasting between apps.

---

## Phase 6 — Review, analytics, and workflow optimization

### Goal

Use execution history to make the workflow measurably better.

### Work

- Per-provider/model usage trends.
- Capacity burn-rate forecasting.
- Task completion/failure rates by worker profile.
- Retry/escalation frequency.
- Median run duration.
- Test-success rate.
- Human-rejection/rework rate.
- Cost estimates for API-metered runs.
- Project health/attention dashboard.
- Scheduled/conditional notifications.

Prefer metrics that affect a decision. Avoid vanity charts.

---

## Phase 7 — Advanced remote operations

Only after the capability/audit model is proven:

- richer process manager;
- local model lifecycle management;
- configured container management;
- package/dev-server workflows;
- restricted terminal mode if still needed;
- integration/launch point for an existing remote-desktop solution.

Do not build a custom remote desktop protocol unless an actual unmet requirement emerges.

---

# Suggested first implementation tasks

The first coding model should receive **small, independently testable tasks**, not “build Sonoran Hub.” Recommended order:

1. Scaffold pnpm monorepo + CI + strict shared TypeScript config.
2. Define shared contracts for `CapacityResource`, machine heartbeat, Task, Run, and RunEvent with tests.
3. Scaffold responsive web shell with placeholder Home/Capacity/Projects/Machines/Tasks routes.
4. Implement API health endpoint and typed web client.
5. Implement OpenRouter capacity adapter + mocked contract tests.
6. Implement DeepSeek balance + pricing-window adapter and verify pricing boundaries with tests.
7. Add Postgres persistence for capacity snapshots.
8. Add Capacity UI using real API data.
9. Scaffold Agent handshake/heartbeat with a fake in-memory machine first.
10. Replace fake Agent with real host telemetry.

That sequence gets useful visible output early while keeping each task reviewable.

# Definition of done for implementation tasks

Every coding task should state its own acceptance criteria, but the default expectation is:

- implementation is scoped to the task;
- relevant unit/integration tests added or updated;
- typecheck/lint/build pass;
- no secrets committed;
- documentation updated when contracts or behavior change;
- failure modes are explicit;
- new external integration code is isolated behind an adapter;
- `git diff --check` (or equivalent whitespace validation) is clean;
- worker summarizes what changed, tests run, remaining risks, and follow-ups.
