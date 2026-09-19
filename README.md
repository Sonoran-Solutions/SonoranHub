# Sonoran Hub

**The control plane for the Sonoran Solutions development workflow.**

Sonoran Hub is a responsive web and Android application for planning projects, monitoring AI capacity, controlling trusted development machines remotely, and dispatching software-development work to local and hosted AI agents.

The core workflow is:

> **Idea → Plan → Task → Route → Execute → Review → Test → PR → Ship**

The project is intentionally designed as a control plane rather than a replacement for GitHub, local developer tooling, or model-provider clients. GitHub remains the durable source of truth for repositories, issues, pull requests, and CI. A trusted **Sonoran Agent** running on each development machine provides outbound-connected local execution and telemetry. Sonoran Hub coordinates the two.

## Product goals

Sonoran Hub should make it practical to manage the Sonoran Solutions workflow from a desktop browser or Android phone, including:

- See the state of active projects and repositories at a glance.
- Capture an idea and turn it into a project, specification, or implementation task.
- Dispatch a task to an appropriate AI model/agent and follow its progress remotely.
- Track remaining quota, balance, reset windows, and current pricing across ChatGPT/Codex, Gemini, DeepSeek, and OpenRouter.
- Use current AI capacity and task complexity as inputs to model-routing decisions.
- Monitor the main development PC and perform safe, explicit remote actions.
- Review agent output, tests, diffs, pull requests, and failures without needing a full desktop session.
- Preserve enough execution history to understand which models and workflows are actually effective.

## Non-goals for the first releases

Sonoran Hub is **not** initially intended to be:

- A home-grown remote desktop implementation.
- An unrestricted internet-facing shell.
- A replacement for GitHub Issues, pull requests, or Actions.
- A general multi-user SaaS product.
- A fully autonomous agent that can merge, deploy, reboot, or destroy data without explicit policy and confirmation.

## Proposed technology stack

| Area | Initial choice |
| --- | --- |
| Web UI | React + TypeScript + Vite |
| Mobile | Capacitor Android wrapper over the same responsive app |
| Styling | Tailwind CSS + shadcn/ui |
| Hub API | TypeScript + Fastify |
| Realtime | WebSocket event stream |
| Shared schemas | Zod |
| Persistent DB | PostgreSQL |
| Local agent state | SQLite |
| Monorepo | pnpm workspaces |
| Repository integration | GitHub App / GitHub API |
| Private machine access | Tailscale/private network + outbound Sonoran Agent connection |
| Notifications | Android push and optional Slack integration |

The stack is deliberately TypeScript-heavy to minimize cross-language friction during the MVP. A lower-level component should move to Rust or another language only when a concrete requirement justifies it.

## Repository layout

The intended monorepo shape is:

```text
SonoranHub/
├── apps/
│   ├── web/                 # React application + Capacitor shell
│   ├── api/                 # Hub control API
│   └── agent/               # Sonoran Agent daemon/CLI
├── packages/
│   ├── contracts/           # Shared API/event schemas
│   ├── ai-capacity/         # Provider capacity adapters + normalization
│   ├── orchestrator/        # Routing/execution policy
│   ├── github/              # GitHub integration helpers
│   └── config/              # Shared config and feature flags
├── docs/
└── README.md
```

This is a target structure, not a requirement to scaffold every package on day one.

## Documentation

- [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [AI capacity dashboard](docs/AI_CAPACITY.md)
- [Sonoran Agent and remote execution](docs/REMOTE_AGENT.md)
- [Security model](docs/SECURITY.md)
- [Initial backlog](docs/BACKLOG.md)

## Developer setup

The repository is a pnpm workspace and expects Node.js 22 or newer with pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

For the live Capacity slice, start a local PostgreSQL instance and apply the
explicit migration before starting the API:

```bash
cp .env.example .env
set -a
source .env
set +a
docker compose up -d postgres
pnpm db:migrate
```

Copy `.env.example` to `.env` and add provider credentials only to the API
environment. The browser receives normalized Hub data and never receives
provider credentials.

Run the applications independently during development:

```bash
pnpm dev:web    # Vite development server
pnpm dev:api    # Fastify API on http://127.0.0.1:3000
pnpm dev:agent  # Sonoran Agent process
```

The API exposes `GET /health`, `GET /machines`,
`POST /machines/:machineId/actions`, `GET /machines/:machineId/actions`, and
`GET /actions/:actionId`, plus `GET /capacity` and bounded
`GET /capacity/history?provider=&since=&limit=`. Open
`http://127.0.0.1:5173/capacity` for the responsive Capacity dashboard or
`http://127.0.0.1:5173/machines` for connected Agent telemetry. The
provider refresh default is every 60 seconds and can be changed with
`CAPACITY_REFRESH_INTERVAL_MS`. The browser polls the Hub API every 15 seconds
for persisted snapshots; it never calls Codex, Gemini, DeepSeek, or OpenRouter directly.
Codex capacity comes from the server-side official local `codex app-server`; an
already-authenticated CLI is required and `CODEX_BIN` can override its path.
Gemini capacity comes from the server-side official Antigravity CLI's
structured read-only `/quota` and `/credits` print commands; an installed,
authenticated CLI with the guarded minimum behavior is required and `AGY_BIN`
can override its path. Hub stores only normalized capacity data and safe metadata, never copied
ChatGPT/Codex or Google credentials. Run the opt-in read-only smoke test with
`pnpm smoke:codex` or `pnpm smoke:gemini`. Neither smoke submits a normal model
prompt or performs login/logout. The
API allows browser requests from the
comma-separated origins in `WEB_ORIGIN`; by default this includes both
`http://127.0.0.1:5173` and `http://localhost:5173`.

For the Phase 1B Agent, set the same temporary bearer credential in
`SONORAN_AGENT_TOKEN` for the API and Agent, then start the Agent with
`SONORAN_HUB_URL=ws://127.0.0.1:3000/agent/ws pnpm dev:agent`. The Agent
creates a stable ID under `~/.sonoran-agent/state`, connects outbound over an
authenticated WebSocket, and reports CPU, memory, disk, and uptime telemetry.
The Agent protocol is v2 and supports only typed `repo.status` and tightly
bounded user-level `service.restart` actions. Cleartext `ws://`
is accepted only for loopback development endpoints; remote Hub connections
must use `wss://`. A configured Hub URL without `SONORAN_AGENT_TOKEN` fails
closed. Set `SONORAN_AGENT_DISK_PATHS=/,/mnt/data` to sample multiple
configured filesystems; paths are trimmed, deduplicated, and statfs-only.

Hub shutdown first stops Agent message processing, requests a bounded graceful
close for live sessions, terminates sockets that do not close in time, and then
lets Fastify finish closing. Protocol rejection is terminal for that socket,
and lifecycle/security transitions are available through the injectable
structured event sink without persisting a full audit stream. Machine detail
metadata includes the persisted Agent protocol version and safe local action
target catalog. The Agent keeps action authority in
`~/.sonoran-agent/policy.json` (or `SONORAN_AGENT_POLICY_PATH`); Hub never
chooses an executable, filesystem path, or systemd unit.

Shared services validate `NODE_ENV`, `LOG_LEVEL`, and `SERVICE_NAME` through
`@sonoran-hub/config`. Structured logs carry service and optional correlation
identifiers; known credential-shaped metadata is redacted before emission. The API
also returns an `x-request-id` response header for request correlation.

## MVP definition

The first genuinely useful milestone is deliberately small:

1. Hub loads on desktop and mobile.
2. Main PC connects through Sonoran Agent and reports online state plus basic telemetry.
3. Hub lists configured Sonoran Solutions projects and their GitHub state.
4. AI Capacity shows real data from OpenRouter, DeepSeek, the locally authenticated Codex app-server, and the official Antigravity CLI-backed Gemini source through the same interface.
5. A user can create a development task, select a project and execution profile, and dispatch it to the main PC.
6. The agent creates an isolated worktree, runs an approved worker command, streams status/events, and reports completion/failure.
7. Hub shows the resulting branch, test result, summary, and pull-request link when available.

If those seven things work reliably from an Android phone away from the main PC, the MVP has succeeded.

## Design principles

1. **GitHub is durable project state.** Hub augments it; it does not create a second competing truth.
2. **The PC connects outward.** Do not expose a root shell or arbitrary command port to the public internet.
3. **Provider differences stay visible.** A dollar balance, a five-hour quota, a weekly allowance, and an off-peak pricing window are different resources and should not be flattened into a fake universal percentage.
4. **Agents work in isolation.** Use worktrees/branches and explicit task sandboxes rather than mutating the developer's active checkout.
5. **Privilege is capability-based.** Reading telemetry and running tests are not equivalent to rebooting a machine or merging code.
6. **Expensive models consume evidence.** Lower-cost workers should gather evidence and attempt bounded work before premium models are escalated to difficult problems where appropriate.
7. **Human review remains a first-class state.** “Agent finished” is not the same thing as “safe to merge.”

## Current status

**Phase 1B implemented.** Agent transport, machine identity, basic telemetry,
typed policy-enforced `repo.status`/user-level `service.restart` actions, durable
action state, and the responsive Machines surface are live. Arbitrary shell,
Git mutation, workers, and task execution remain deferred.

Start with [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
