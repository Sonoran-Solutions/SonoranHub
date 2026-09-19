# Product Requirements

## 1. Product statement

Sonoran Hub is the personal control plane for the Sonoran Solutions software-development workflow. It should let one operator move from idea capture to shipped code while away from the main development PC, without giving up the safety, visibility, and review steps expected when working locally.

The product should work well in two primary contexts:

- **Desktop web:** planning, reviewing diffs, comparing execution history, inspecting logs, and managing projects.
- **Android mobile:** checking status, capturing ideas, dispatching bounded work, approving/rejecting safe actions, reviewing summaries, and handling interruptions while away from the PC.

## 2. Primary user journeys

### 2.1 Check mission control

The user opens Hub and immediately sees:

- Main development machine online/offline state.
- CPU, memory, GPU, storage, and selected long-running processes.
- Active tasks and agents.
- Repositories with failing CI or pull requests awaiting review.
- Current AI capacity across configured providers.
- Important failures, blocked tasks, or actions awaiting approval.

The home view should answer: **“What needs my attention?”**

### 2.2 Capture an idea

The user enters free-form text from desktop or phone. Hub stores the raw thought before any AI processing and may then classify it as:

- new project idea;
- existing project feature;
- bug/investigation;
- research topic;
- operational task;
- note with no immediate action.

The user can later promote that thought into a project brief, GitHub issue, or implementation task. This is the integration point for the ThoughtRouter concept.

### 2.3 Create and dispatch a development task

The user chooses a project and provides a goal. Hub builds a task specification containing:

- goal;
- relevant project/repository;
- context/evidence;
- constraints;
- acceptance criteria;
- risk classification;
- execution profile/model selection;
- test expectations.

Hub then sends the task to a trusted Sonoran Agent. The Agent performs approved preparation, such as creating a branch/worktree, and starts the selected worker.

### 2.4 Follow execution remotely

While work runs, Hub should show high-level lifecycle states rather than forcing the user to read a raw terminal stream:

`QUEUED → PREPARING → RUNNING → TESTING → REVIEW_READY | BLOCKED | FAILED | CANCELED`

Detailed logs remain available on demand.

The user should be able to:

- cancel a task;
- inspect current step and recent events;
- see model/provider being used;
- see elapsed time and provider-capacity impact when available;
- provide follow-up instructions;
- escalate a task to a stronger model using the current evidence bundle.

### 2.5 Review completed work

A completed task should present:

- concise worker summary;
- changed files;
- test/check results;
- known risks or incomplete items;
- branch/worktree state;
- pull-request link if one exists;
- optional second-model review result.

“Worker exited successfully” must never be represented as equivalent to “change is safe to merge.”

### 2.6 Understand AI capacity

The user should be able to answer:

- How much ChatGPT/Codex capacity is left and when do the windows reset?
- What Gemini capacity is available and when will it refresh?
- How much DeepSeek API balance remains, and is the current pricing window peak or off-peak?
- How much OpenRouter credit/budget remains and how much has been spent recently?
- Which provider/model is the best routing choice for a new task right now?

Capacity data must preserve the semantics supplied by each provider instead of forcing all providers into one fake quota percentage.

### 2.7 Control the main PC safely

From Hub, the user can inspect machine status and invoke approved operations such as:

- start/stop/restart configured services;
- launch/stop development servers;
- inspect or stop selected processes;
- unload configured local AI workloads;
- run repository status/test commands;
- inspect logs;
- reboot/shutdown only with explicit elevated confirmation.

An unrestricted browser-accessible shell is not part of the MVP.

## 3. Core product areas

### Mission Control

Responsive overview of machines, tasks, GitHub state, AI capacity, and attention items.

### Projects

A project cockpit combining repository state, tasks, documentation pointers, builds/CI, execution history, and notes.

Phase 2A & 2B implement the project cockpit and real-time reconciliation plane:
- Project portfolio list (`/projects`) showing configured Sonoran Solutions projects, repository counts, open PRs, open issues, and aggregated CI status.
- Project detail cockpit (`/projects/:projectId`) with Overview, per-repository breakdown, default branches, recent commit, open PRs with author and CI badges, open issues, and aggregated CI check runs / statuses.
- Mission Control Home attention card surfacing repositories with failing CI or PRs awaiting review, with bounded counter indicators (`3+`).
- Signed GitHub webhook ingestion (`POST /github/webhooks`) reconciling project state with sub-second latency on push, PR, issue, and check run events, backed by periodic polling fallback (every 60s).
- Tasks, Runs, and Notes tabs exist in the cockpit as clearly labeled placeholders pending Phase 3 task execution. GitHub mutation and agent worker tasks (Phase 3) remain deferred.

### Tasks / Runs

Structured work requests and their immutable execution history.

### AI Capacity

Provider-aware quota, balance, pricing, reset, and usage snapshots plus routing recommendations.

### Machines

Trusted-agent inventory, telemetry, capabilities, services, processes, and approved actions.

### Ideas

Fast capture and promotion into structured project work.

### Settings

Provider integrations, repositories, machine policies, command capabilities, notification rules, and feature flags.

## 4. Data ownership and sources of truth

Hub should own:

- task/run state;
- machine inventory and capability policy;
- provider-capacity snapshots;
- routing decisions and explanations;
- idea inbox;
- notification state;
- local execution metadata.

GitHub should remain authoritative for:

- repositories;
- branches/commits;
- issues;
- pull requests;
- CI/Actions state;
- merged code.

Provider services remain authoritative for quota/balance/pricing data. Hub stores time-stamped snapshots and does not invent precision providers do not expose.

## 5. UX requirements

- Mobile layout must be useful at narrow Fold/phone widths, not merely technically responsive.
- Important state should be readable without opening logs.
- Actions that can disrupt the host must show consequence and target before confirmation.
- Stale provider or machine data must be visibly marked with last-successful-update time.
- A task should have a stable URL/deep link.
- Desktop should support dense information; mobile should prioritize attention items and actions.
- Failures should expose actionable diagnostics rather than generic “something went wrong” messaging.

## 6. Non-functional requirements

### Reliability

- Agent reconnect should be automatic.
- Temporary Hub/API loss must not corrupt a running local task.
- The local agent should journal enough state to reconcile after reconnect/restart.
- Provider adapter failures must degrade independently; a broken Gemini collector must not take down the dashboard.

### Security

See [SECURITY.md](SECURITY.md). The minimum principles are outbound machine connections, least privilege, explicit capability policy, secret isolation, and elevated confirmations.

### Observability

Hub should emit structured logs and retain task/run event history. Provider collector failures, agent disconnects, command denials, and task state transitions must be observable.

### Portability

The control plane should not assume only one PC forever. Initial UX can optimize for the main PC, but the underlying agent protocol should support multiple machines.

## 7. MVP acceptance criteria

The MVP is complete when all of the following can be demonstrated from an Android device on a network different from the main PC:

1. User authenticates to Hub.
2. Main PC appears online with fresh basic telemetry.
3. At least one safe remote machine action succeeds and is audited.
4. Hub lists configured GitHub projects with current branch/PR/CI summary.
5. OpenRouter and DeepSeek capacity collectors show live normalized resources.
6. A task can be created for a project and dispatched to the main PC.
7. The Agent creates an isolated worktree/branch and launches an approved worker.
8. Task progress appears in Hub through structured events.
9. Tests/checks run and their result is reported.
10. The final screen links the generated branch or pull request and preserves the run history.

ChatGPT/Codex and Gemini capacity adapters are high-priority follow-ups if either proves too brittle to block the first end-to-end task demonstration.

## 8. Explicitly deferred

- Full remote desktop implementation.
- General arbitrary shell access from the public web UI.
- Automated production deploys without approval.
- Autonomous merge to protected/default branches.
- Multi-tenant SaaS billing/permissions.
- iOS packaging.
- Complex cross-user collaboration features.
