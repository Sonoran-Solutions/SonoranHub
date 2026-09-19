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

### First vertical slice status — implemented

Implemented providers: OpenRouter, DeepSeek, Codex, and Gemini.

The OpenRouter/DeepSeek Capacity slice is implemented through the coordinator,
PostgreSQL snapshot persistence, Fastify read API, and responsive React
dashboard. Codex and Gemini capacity are also implemented through their
official local source boundaries and the same persistence/API/UI path.

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

- [x] Prefer the locally authenticated official Codex app-server boundary rather than copying browser cookies/tokens into Hub.
- [x] Implement a reusable Hub-local source capable of requesting structured account and rate-limit state; keep the source contract ready for a later Agent transport.
- [x] Normalize primary/secondary quota windows, reset times, additional buckets, spend control, credits, and available reset-credit information when exposed.
- [x] Version/document the Codex integration because the app-server protocol can evolve.

#### Provider 4: Gemini

- [x] Put all collection logic behind a `GeminiCapacitySource` interface.
- [x] Prefer official structured/headless data when available.
- [x] If the initial implementation must rely on locally available Antigravity state/CLI behavior, isolate it behind the adapter and mark source confidence/staleness explicitly.
- [x] Do not make brittle terminal-output parsing a permanent architectural dependency.

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

### Phase 1A status

Implemented: authenticated outbound Agent transport, versioned hello/heartbeat
contracts, stable machine identity, bounded CPU/RAM/disk/uptime telemetry,
PostgreSQL machine metadata/latest telemetry persistence, live
ONLINE/STALE/OFFLINE semantics, and responsive Home/Machines views. Enrollment
UI, workers, and task execution remain deferred to later phases.

Phase 1A hardening also provides bounded Hub-owned Agent shutdown, terminal
protocol rejection, persisted protocol-version metadata, configured statfs
disk paths, and an injectable lifecycle/security event sink. These events are
structured hooks only; Phase 1B adds durable action records without turning the
event sink into a full audit-history platform.

### Phase 1B status

Implemented typed policy-enforced remote actions: read-only `repo.status` and
user-level-systemd-only `service.restart`. Agent protocol v2 carries a safe
target catalog and immutable action lifecycle messages. Hub action records are
durable, audited through the existing event seam, and never automatically
replayed across disconnect or session replacement. Arbitrary shell, root/system
services, Git mutation, task execution, workers, enrollment, and machine power
control remain deferred.

### Work

#### Agent identity and registration

- [x] Generate a stable Agent/machine ID.
- Enrollment/bootstrap UI remains deferred; Phase 1A uses a temporary machine token outside Git.
- [x] Establish an authenticated outbound WebSocket connection.
- [x] Add protocol version and Agent version to handshake.
- [x] Add heartbeat and reconnect with jitter/backoff.
- [x] Stop live sessions with a bounded Hub shutdown grace period.
- [x] Make protocol rejection terminal for the connection.
- [x] Persist and expose the negotiated protocol version.

#### Telemetry

Collect a bounded initial set:

- [x] OS/hostname;
- [x] uptime;
- [x] CPU utilization;
- [x] RAM total/used;
- [x] disk total/used for configured volumes;
- [x] configure bounded comma-separated disk paths through the Agent environment;
- GPU and process/service summaries remain deferred.

Do not block the phase on perfect cross-platform GPU support.

#### Capability policy

Phase 1A advertised only telemetry. Phase 1B adds the two policy-derived
capabilities below; all other capabilities remain future work:

- [x] `machine.read.telemetry`
- `process.read`
- `process.stop.allowed`
- `service.read`
- `service.restart.allowed` (Phase 1B, local user-systemd targets only)
- `repo.read` (Phase 1B, local repository targets only)
- `repo.test.allowed`
- `task.execute`
- `machine.reboot`
- `machine.shutdown`

The Agent advertises granted capabilities to Hub.

#### Phase 1B remote actions

Typed `repo.status` and `service.restart` are implemented with local policy
authorization, bounded fixed subprocesses, durable action lifecycle records,
safe audit metadata, and no automatic retry. Arbitrary shell, process control,
Git mutation, root/system services, and machine power control remain deferred.

### Exit criteria

- Agent can remain connected/reconnect for an extended session.
- Hub correctly distinguishes online/stale/offline.
- Mobile can view fresh main-PC telemetry.
- API restart leaves persisted machines offline until their Agents reconnect.
- Phase 1B actions remain limited to the typed policy-enforced catalog.

---

## Phase 2 — GitHub/project control plane

### Phase 2A — Read-only GitHub project control plane (Implemented)

#### Goal

Make Hub useful for navigating the Sonoran Solutions project portfolio using GitHub
as the durable source of truth, without creating duplicate editable state.

#### Work

- [x] Implement read-only GitHub integration adapter (`packages/github`) with strict runtime assertions preventing mutation.
- [x] Authenticate using GitHub App (`@octokit/auth-app`) with support for PEM key files, strings, and custom base URLs.
- [x] Configure projects and repositories via `config/projects.json` with schema validation and `SONORAN_PROJECTS_PATH` override.
- [x] Persist project and repository configuration to PostgreSQL (`projects`, `project_repositories`, `project_github_snapshots` in `db/migrations/005_projects.sql`).
- [x] Aggregate CI/Actions check runs and commit statuses with deterministic priority (`failure` > `pending` > `success` > `neutral` > `unknown`).
- [x] Implement partial failure resilience: errors in one repository do not break project snapshots.
- [x] Graceful degradation: unconfigured GitHub credentials render safe stubs without failing API startup or breaking the UI.
- [x] Expose `GET /projects` and `GET /projects/:projectId` from Fastify API.
- [x] Build responsive desktop and mobile web UI: Projects list (`/projects`), Project detail cockpit (`/projects/:projectId`), and Home Attention Card.
- [x] Add opt-in read-only smoke script `pnpm smoke:github`.

#### Exit criteria

- [x] Sonoran Solutions projects and repositories are navigable in Hub.
- [x] Hub does not duplicate full issue/PR bodies as independent editable truth.
- [x] Project cockpit works on desktop and mobile.
- [x] All GitHub integration operations are strictly read-only.

### Phase 2B — Signed GitHub Webhook Ingestion & Targeted Reconciliation (Implemented)

#### Goal

Receive real-time GitHub webhook notifications rather than relying solely on periodic polling,
coalesce rapid updates, and trigger targeted reconciliation via authoritative GitHub read APIs
without turning webhook payloads into a second source of truth.

#### Work

- [x] Implement timing-safe raw-body HMAC-SHA256 signature verification (`X-Hub-Signature-256`) against `GITHUB_WEBHOOK_SECRET` in `apps/api/src/webhookSignature.ts`.
- [x] Parse exact raw request bytes before JSON decoding; reject payloads > 1 MiB with Fastify HTTP 413.
- [x] Store webhook delivery audit records in PostgreSQL (`github_webhook_deliveries` in `db/migrations/006_github_webhook_deliveries.sql`) and in-memory store for test/offline use.
- [x] Atomic delivery deduplication (`ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`) preventing replayed deliveries from enqueueing redundant reconciliation.
- [x] Keyed refresh coordination (`GitHubRefreshCoordinator`) with configurable debounce (500–1500ms), burst coalescing, and dirty follow-up scheduling during in-flight refreshes.
- [x] Targeted repository reconciliation (`ProjectService.refreshRepository`) serialized per-project via FIFO locks (`withProjectLock`), preserving unaffected repository snapshots and rate limit backoffs.
- [x] Automated retention management (`createWebhookRetentionManager`) pruning delivery records older than `GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS` (default 72h).
- [x] Update attention issue counting to evaluate all fetched items on the page, keep item list bounded, and signal `attentionIssueHasMore` / `attentionIssuesHasMore` in UI (`3+`).
- [x] End-to-end smoke verification script `pnpm smoke:github-webhook` testing missing/bad signatures, pings, unhandled events, push events, deduplication, and targeted reconciliation.

#### Exit criteria

- [x] Webhook payload verification is constant-time and strictly precedes JSON parsing.
- [x] Webhook payloads are never persisted as project truth or executed as commands.
- [x] Rapid bursts coalesce cleanly into single debounced read-API refreshes.
- [x] Periodic polling (`GITHUB_REFRESH_INTERVAL_MS`) remains active as durable fallback.
- [x] Web UI correctly displays bounded attention counters (`3+`).

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
