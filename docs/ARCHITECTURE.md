# Architecture

## 1. System overview

Sonoran Hub is a control plane with three primary runtime zones:

1. **Hub UI** — responsive web application packaged for Android with Capacitor.
2. **Hub API/control service** — authentication, projects, tasks, capacity snapshots, routing, notifications, and event fan-out.
3. **Sonoran Agent** — a trusted daemon on each development machine that owns local execution, telemetry, and approved host actions.

External systems such as GitHub and AI providers remain authoritative for their own data.

```text
                   ┌──────────────────────────────┐
                   │         SONORAN HUB          │
                   │                              │
                   │  React Web / Android app     │
                   └──────────────┬───────────────┘
                                  │ HTTPS / WS
                                  ▼
                   ┌──────────────────────────────┐
                   │       Hub Control API        │
                   │                              │
                   │ Auth                         │
                   │ Projects                     │
                   │ Tasks / Runs                 │
                   │ AI Capacity                  │
                   │ Router / Orchestrator        │
                   │ Notifications                │
                   │ Audit / Events               │
                   └───────┬──────────┬───────────┘
                           │          │
                     GitHub│          │ outbound persistent
                           │          │ Agent connection
                           ▼          ▼
                  ┌────────────┐  ┌─────────────────────────┐
                  │   GitHub   │  │      SONORAN AGENT      │
                  │ repos/PRs  │  │     trusted machine     │
                  │ issues/CI  │  │                         │
                  └────────────┘  │ telemetry               │
                                  │ capabilities            │
                                  │ git/worktrees           │
                                  │ worker processes         │
                                  │ local model tools        │
                                  │ service control          │
                                  └───────────┬─────────────┘
                                              │
                  ┌───────────────────────────┼───────────────────────┐
                  ▼                           ▼                       ▼
          Hosted AI providers          Local AI runtimes       Dev tooling
          OpenAI/Google/etc.            model servers           git/tests/etc.
```

## 2. Monorepo boundaries

```text
apps/
  web/          Browser UI and Capacitor Android shell
  api/          Hub HTTP/WebSocket API
  agent/        Machine daemon and worker supervisor

packages/
  contracts/    Zod schemas and shared DTO/event types
  ai-capacity/  Provider capacity adapters and normalization
  orchestrator/ Routing and task execution policy
  github/       GitHub integration boundary
  config/       Shared configuration helpers
```

### Dependency rule

`contracts` should remain lightweight and side-effect free. UI, API, and Agent communicate through versioned contracts rather than importing each other's internal modules.

The provider adapters and GitHub integration are boundaries, not places for product/business logic. Routing logic consumes normalized provider and task data from those boundaries.

### Capacity vertical slice

The first end-to-end Capacity path is:

```text
OpenRouter / DeepSeek / Codex / Gemini adapters
  -> CapacityCoordinator and D1 scheduler
  -> CapacityService
  -> CapacitySnapshotStore -> PostgreSQL
  -> Fastify GET /capacity and /capacity/history
  -> React /capacity view
```

The coordinator records probe health independently from collection. A failed
probe is not a generic collection gate because an adapter may still produce
useful partial or derived resources. In particular, DeepSeek pricing is
derived from verified UTC configuration even when its authenticated wallet
request is unavailable.

Codex is intentionally split into a protocol/source layer and a normalized
adapter layer:

```text
Hub API Capacity runtime
  -> CodexCapacityAdapter
  -> CodexCapacitySource
  -> official local `codex app-server` over stdio
```

The source owns the JSONL process, request correlation, initialization
handshake, timeouts, notification handling, and cleanup. It reads only
official structured `account/read` and `account/rateLimits/read` data. Today it
runs locally in Hub API; a future Sonoran Agent can supply the same source
contract without changing normalized provider resources or the dashboard.
`CODEX_BIN` is server-side configuration only. Missing Codex installation or
authentication is an independent provider-unavailable state and does not stop
the Capacity subsystem or other providers.

Gemini follows the same boundary-first rule but uses the official
Antigravity CLI's short-lived structured read-only commands rather than a
persistent process:

```text
Hub API Capacity runtime
  -> GeminiCapacityAdapter
  -> GeminiCapacitySource
  -> AntigravityCliSource
  -> `agy -p "/quota" --output-format json`
  -> `agy -p "/credits" --output-format json`
```

`AGY_BIN` is server-side configuration only and defaults to `agy`. The source
runs from a neutral directory with `shell: false`, finite output/timeout
limits, and SIGTERM/SIGKILL cleanup. It accepts only the official structured
command envelope with `num_turns: 0`; a normal model-turn response is a hard
failure so an old CLI cannot burn quota while pretending to answer `/quota`.
The minimum guarded behavior is Antigravity CLI 1.1.11; the local validated
version is 1.2.3. No browser cookies, OAuth credentials, private endpoints,
TUI scraping, or normal model prompts are involved. The adapter keeps
Antigravity quota groups/buckets and G1/AI credits as separate normalized
Gemini resources and preserves partial success. As with Codex, this source
can later move behind Sonoran Agent without changing the dashboard contract.

## 3. Hub API responsibilities

The API owns:

- authenticated user/session state;
- project configuration;
- task definitions and lifecycle;
- execution-run records;
- provider-capacity snapshots;
- model-routing decisions;
- machine registration and capability metadata;
- audit events;
- notification decisions;
- WebSocket fan-out to connected clients;
- reconciliation of Agent state after reconnect.

It should **not** own:

- arbitrary host command execution;
- direct access to the developer's filesystem;
- provider CLI credentials that only need to exist on the Agent host;
- Git working-copy mutation.

## 4. Sonoran Agent responsibilities

The Agent is the execution authority for its host.

Responsibilities:

- establish an authenticated outbound connection to Hub;
- advertise machine identity, version, and granted capabilities;
- publish telemetry;
- validate every requested action against local policy;
- create and clean task worktrees;
- supervise worker processes;
- capture structured worker events and bounded logs;
- run configured tests/checks;
- inspect local Git state;
- invoke configured service/process actions;
- journal task state locally so a Hub disconnect is recoverable;
- report results and artifacts.

The Agent must be able to reject a request even if Hub asks for it. Hub authorization and local Agent policy are both required.

## 5. Connectivity model

### Preferred model

The Agent establishes a persistent outbound authenticated connection to Hub, ideally over a private Tailscale network when possible. The user never opens a public inbound port on the development PC for arbitrary remote command execution.

A WebSocket is sufficient for the initial control protocol. The design should not couple domain events to WebSocket specifics so transport can change later.

### Heartbeat

Agent sends a heartbeat with:

- machine ID;
- agent version;
- timestamp;
- current task count;
- capability-policy hash/version;
- lightweight telemetry summary.

Hub derives `ONLINE`, `STALE`, and `OFFLINE` from heartbeat age instead of treating a socket boolean as the full truth.

## 6. Task and execution model

A **Task** is user intent. A **Run** is one attempt to execute a task.

This distinction matters because the same task may be retried with another model, another machine, or updated instructions.

### Task state

Suggested task states:

```text
DRAFT
READY
QUEUED
RUNNING
NEEDS_INPUT
REVIEW_READY
COMPLETED
CANCELED
```

### Run state

Suggested run states:

```text
QUEUED
PREPARING
RUNNING
TESTING
SUCCEEDED
FAILED
BLOCKED
CANCELED
LOST
```

A successful Run does not automatically complete a Task. Review policy decides whether a successful run advances to `REVIEW_READY` or `COMPLETED`.

### Worktree isolation

Each coding run should receive:

- task/run ID;
- repository;
- base ref;
- unique branch name;
- isolated Git worktree path;
- explicit worker command/profile;
- scoped environment variables/secrets;
- acceptance checks.

A worker should never default to the operator's currently active checkout.

## 7. Event model

Use an append-oriented event stream for important lifecycle changes. Examples:

```text
agent.connected
agent.heartbeat
agent.capabilities_changed
machine.telemetry
capacity.snapshot_updated
task.created
task.updated
run.queued
run.preparing
run.worker_started
run.progress
run.test_started
run.test_finished
run.blocked
run.failed
run.completed
run.canceled
approval.requested
approval.resolved
```

Events should carry stable IDs and timestamps and be safe to replay for UI reconciliation.

Raw worker stdout/stderr is **not** the event stream. Logs are an attached data source. The Agent should translate meaningful milestones into structured events where possible.

## 8. Data model sketch

Initial relational entities:

- `users`
- `projects`
- `repositories`
- `machines`
- `machine_capabilities`
- `ideas`
- `tasks`
- `runs`
- `run_events`
- `run_artifacts`
- `approvals`
- `capacity_sources`
- `capacity_snapshots`
- `routing_decisions`
- `notifications`
- `audit_events`

Do not prematurely model every provider field as a database column. Store normalized fields plus a versioned provider-specific payload for diagnostics.

## 9. GitHub integration

GitHub remains durable code/project state. Hub should use a GitHub App where practical for:

- repository discovery;
- issues;
- pull requests;
- Actions/CI state;
- webhooks;
- creating task-related issues/PRs when requested.

Hub's project record should reference repositories rather than duplicating repository history.

Incoming GitHub webhooks should become normalized events and update project/task views.

## 10. AI capacity architecture

Provider adapters publish one or more `CapacityResource` values rather than one universal “remaining quota” field.

See [AI_CAPACITY.md](AI_CAPACITY.md).

The Orchestrator consumes capacity data but does not own provider authentication or scraping logic.

## 11. Orchestrator boundary

The Orchestrator should answer two related questions:

1. **Where should this task run?** — machine/execution environment.
2. **Which worker/model profile should handle it?** — based on task type, expected difficulty, provider availability, quota, price, and configured preferences.

A routing decision should be explainable and persisted, for example:

```json
{
  "taskId": "...",
  "selectedProfile": "deepseek-pro-high",
  "reasons": [
    "task classified as difficult debugging",
    "DeepSeek is currently off-peak",
    "ChatGPT five-hour capacity below preservation threshold"
  ],
  "alternatives": ["gpt-sol-high", "gemini-pro-high"]
}
```

Model names and tiers must live in configuration, not be hard-coded throughout the UI.

## 12. Failure and reconciliation rules

- **Hub restarts:** rebuild active state from DB; Agents reconnect and reconcile running tasks.
- **Agent restarts:** read local journal, inspect child/task state, report any interrupted Runs as `LOST` or resumable according to policy.
- **Network loss:** running work may continue locally if policy allows; destructive or approval-gated operations must not silently proceed without the required approval.
- **Provider collector failure:** retain last known snapshot as stale and surface the error; do not zero out quota/balance.
- **Worker crashes:** capture exit status, recent logs, Git status, and available artifacts before marking failed.

## 13. Deployment shape

For early personal use, keep deployment boring:

- one Hub API instance;
- one PostgreSQL database;
- static web assets served alongside or from a simple web host;
- one Sonoran Agent service on the main PC;
- optional Tailscale private connectivity;
- secrets injected through environment/secret-store configuration rather than repository files.

Do not introduce Kubernetes, a message broker, or a fleet scheduler until actual scale requires them.
