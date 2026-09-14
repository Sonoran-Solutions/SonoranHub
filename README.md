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

Run the scaffolded applications independently during development:

```bash
pnpm dev:web    # Vite development server
pnpm dev:api    # Fastify API on http://127.0.0.1:3000
pnpm dev:agent  # startup-only Sonoran Agent process
```

The API currently exposes `GET /health`. The web app and packages are intentionally
scaffolds; product integrations are introduced in later implementation phases.

## MVP definition

The first genuinely useful milestone is deliberately small:

1. Hub loads on desktop and mobile.
2. Main PC connects through Sonoran Agent and reports online state plus basic telemetry.
3. Hub lists configured Sonoran Solutions projects and their GitHub state.
4. AI Capacity shows real data from at least OpenRouter and DeepSeek, with ChatGPT/Codex and Gemini adapters following behind the same interface.
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

**Planning / foundation.** No production implementation exists yet.

Start with [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
