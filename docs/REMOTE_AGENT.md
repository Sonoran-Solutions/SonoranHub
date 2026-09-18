# Sonoran Agent and Remote Execution

The Sonoran Agent is the trusted local execution boundary for Sonoran Hub. It runs on a development machine and performs only actions permitted by local policy.

The most important rule is:

> **Hub may request an action; the Agent decides whether that action is permitted on this machine.**

This prevents a compromised Hub session from automatically becoming unrestricted host access.

## Phase 1A boundary

The implemented Phase 1A Agent is read-only: it advertises only
`machine.read.telemetry`, publishes bounded telemetry, and maintains an
authenticated outbound WebSocket session. It does not expose action RPCs,
shell access, process or service control, repository operations, task
execution, worker execution, reboot/shutdown, or enrollment UI. Those remain
deferred to Phase 1B or later.

The Hub owns active session shutdown. It stops processing new Agent messages,
requests a bounded graceful close with `hub_shutdown`, terminates hung sockets,
and then completes Fastify shutdown. The Agent treats this like any other
disconnect and reconnects normally. Rejected protocol connections are
terminal: queued messages from that socket cannot update machine state.

The current machine row persists the Agent protocol version alongside Agent
metadata and latest telemetry. `SONARAN_AGENT_DISK_PATHS` accepts a
comma-separated, trimmed, deduplicated list of up to 32 statfs paths and
defaults to `/`; inaccessible paths are omitted individually.

MachineHub exposes an injectable lifecycle event sink for authentication
failures, connection/hello, protocol rejection, replacement, disconnect, and
ONLINE/STALE transitions. Events use safe metadata only and are structured
logging hooks, not a durable audit-history platform. Credentials, raw frames,
and raw telemetry are never included.

## 1. Responsibilities

The Agent owns:

- outbound connection and machine identity;
- capability advertisement;
- host telemetry;
- configured process/service control;
- repository discovery and Git operations;
- worktree lifecycle;
- worker launch/cancel/supervision;
- local provider collectors that require existing CLI authentication;
- acceptance-check execution;
- log capture;
- result/artifact reporting;
- local journal/recovery state.

The Agent does **not** make high-level product-routing decisions. It executes a Run specification that has already been approved/routed by Hub, subject to its own policy.

## 2. Outbound connection

The Agent should initiate the connection to Hub rather than listen on an internet-accessible arbitrary command port.

Initial transport can be authenticated WebSocket over HTTPS/private network.

Handshake should include:

```json
{
  "protocolVersion": 1,
  "agentVersion": "0.x",
  "machineId": "stable-generated-id",
  "machineName": "developer-friendly-name",
  "platform": "linux",
  "capabilities": [],
  "policyRevision": "hash-or-version"
}
```

Hub must reject unsupported protocol versions cleanly.

## 3. Enrollment

Do not make first-run enrollment depend on copying a long-lived admin API key into random config files.

A reasonable first flow:

1. Agent starts unregistered and prints a short-lived enrollment request/code.
2. User approves the machine from authenticated Hub.
3. Hub issues machine-specific credentials.
4. Agent stores credentials in an OS-appropriate protected location.
5. Credentials can be revoked from Hub without affecting other machines.

For the earliest local prototype, a manually provisioned machine token is acceptable if clearly marked temporary and stored outside Git.

## 4. Capability model

Capabilities should be fine-grained enough to distinguish read-only observation from disruptive control.

Example capability vocabulary:

```text
machine.read.telemetry
machine.read.hardware
machine.reboot
machine.shutdown

process.read
process.stop.allowed

service.read
service.start.allowed
service.stop.allowed
service.restart.allowed

repo.read
repo.fetch.allowed
repo.worktree.create
repo.test.allowed
repo.commit.allowed
repo.push.allowed

task.execute
worker.cancel

provider.capacity.chatgpt
provider.capacity.gemini
provider.capacity.deepseek
provider.capacity.openrouter
```

`.allowed` actions should also be constrained to explicit configured targets where appropriate.

Example:

```yaml
processes:
  - id: comfyui
    match:
      commandContains: "ComfyUI"
    permissions:
      read: true
      stop: true

services:
  - id: sonoran-dev-api
      systemdUnit: "sonoran-dev-api.service"
    permissions:
      read: true
      restart: true
```

Never implement “kill any PID” as the only process-control primitive for mobile use.

## 5. Repository allowlist

The Agent should operate only on configured repository roots.

Example:

```yaml
repositories:
  roots:
    - /home/user/src
  allowedRemotes:
    - github.com/Sonoran-Solutions/*
```

Before creating a worktree, validate:

- repository path is under an allowed root;
- remote matches allowed policy;
- requested base ref exists or can be fetched under policy;
- worktree destination is under the Agent-owned workspace root.

Do not trust a path supplied by Hub blindly.

## 6. Worktree lifecycle

Suggested Agent-owned directory:

```text
~/.sonoran-agent/
  state/
  logs/
  runs/
  worktrees/
    <repo-id>/
      <run-id>/
```

For each coding Run:

1. Resolve configured repository.
2. Check/fetch base ref.
3. Create branch name such as `hub/<task-short-id>-<slug>`.
4. Create isolated worktree.
5. Record initial commit SHA.
6. Launch worker with worktree as working directory.
7. Run checks.
8. Record final Git state.
9. Keep worktree while review is pending.
10. Remove only under explicit cleanup policy.

Never remove a worktree containing unreported/unpushed changes automatically because Hub temporarily lost state.

## 7. Worker execution adapter

Agent execution should be abstracted behind worker profiles.

Example configuration:

```yaml
workers:
  opencode-deepseek:
    adapter: opencode
    executable: /usr/local/bin/opencode
    modelProfile: deepseek-pro-high
    maxRunMinutes: 120

  codex-sol:
    adapter: codex
    executable: /usr/local/bin/codex
    modelProfile: gpt-sol-high
    maxRunMinutes: 120
```

The exact CLI flags belong in the adapter implementation/config, not in task objects from Hub.

### Worker result

Normalize output to something like:

```ts
interface WorkerResult {
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  summary?: string;
  blockedReason?: string;
  logsRef: string;
  usage?: Record<string, unknown>;
}
```

Provider/tool-specific data can be attached without forcing the whole app to understand it.

## 8. Structured progress

The Agent should emit meaningful events such as:

```text
run.preparing_worktree
run.worker_started
run.worker_progress
run.worker_exited
run.tests_started
run.tests_finished
run.git_state_captured
run.result_ready
```

A raw line of terminal output should generally stay in the log stream rather than become a domain event.

## 9. Command execution

Avoid a generic RPC shaped like:

```json
{ "command": "sudo whatever the server says" }
```

Prefer typed actions:

```json
{
  "action": "service.restart",
  "target": "sonoran-dev-api"
}
```

or:

```json
{
  "action": "repo.run_check",
  "repositoryId": "dualdex",
  "checkId": "test"
}
```

The Agent resolves the action into a locally configured executable/arguments and validates it before launch.

A restricted terminal can be considered later, but typed actions should remain the primary mobile-control mechanism.

## 10. Telemetry

Start with low-cost telemetry on a modest interval and use slower intervals for expensive metrics.

Suggested initial summary:

```ts
interface MachineTelemetry {
  capturedAt: string;
  uptimeSeconds: number;
  cpuPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  disks: Array<{
    id: string;
    usedBytes: number;
    totalBytes: number;
  }>;
  gpu?: Array<{
    id: string;
    utilizationPercent?: number;
    memoryUsedBytes?: number;
    memoryTotalBytes?: number;
    temperatureC?: number;
  }>;
}
```

Do not let missing GPU metrics fail the entire heartbeat.

## 11. Local journal and recovery

The Agent should use SQLite or another transactional local store for:

- machine credential metadata;
- active run IDs;
- process IDs/worker handles;
- repository/worktree mapping;
- last acknowledged event sequence;
- pending result uploads;
- cleanup state.

On restart:

1. inspect prior active Runs;
2. determine whether supervised processes still exist;
3. inspect worktree/Git state;
4. reconcile with Hub;
5. mark interrupted Runs explicitly rather than silently losing them.

## 12. Cancellation

Cancellation should be graceful first, forced second:

1. request adapter-specific graceful cancellation;
2. wait a configured bounded period;
3. terminate worker process group if still alive;
4. preserve worktree/logs;
5. capture final Git state;
6. mark Run canceled.

Do not clean the branch/worktree merely because the worker was canceled.

## 13. Secrets

Worker credentials and provider tokens that are only needed locally should remain on the Agent host whenever possible.

Hub should send references to configured profiles, not plaintext secrets.

Example:

```json
{
  "workerProfile": "deepseek-pro-high"
}
```

not:

```json
{
  "apiKey": "..."
}
```

## 14. Initial Agent milestone

The first Agent release only needs to prove:

- enrollment/configuration;
- persistent authenticated connection;
- heartbeat/reconnect;
- CPU/RAM/disk telemetry;
- capability advertisement;
- one safe configured service/process action;
- one repository status/check action;
- audit trail.

Worktree/worker orchestration comes immediately after that foundation is stable.
