# Security Model

Sonoran Hub combines remote machine control, source-code access, provider credentials, and AI-agent execution. That combination is powerful enough that security boundaries must be designed before feature growth.

This document defines the minimum architecture expectations for early releases.

## 1. Threat model

Assume any of the following can happen:

- Hub web session is stolen.
- Hub API is exposed to malicious input.
- A worker/model produces unsafe or malicious commands.
- A provider token leaks from logs.
- A GitHub webhook or external payload is malformed/untrusted.
- Hub asks an Agent to perform an action that should not be allowed locally.
- A task prompt attempts to manipulate the worker into reading unrelated secrets or repositories.
- Agent loses connection mid-run.
- A mobile device is lost while authenticated.

The system should limit the blast radius of each event instead of assuming one perfect authentication barrier.

## 2. Security principles

### Outbound Agent connectivity

Development machines should not expose a general-purpose public remote-command listener. The Agent initiates its authenticated connection outward to Hub/private infrastructure.

### Defense in depth

Hub authorization and Agent-local authorization are separate checks. Passing one does not bypass the other.

### Least privilege

Capabilities should be granted per machine, target, and action. Read telemetry, restart a configured dev service, push a branch, reboot the host, and merge a PR are different privileges.

### No secret-by-default telemetry

Logs/events must not include full environment dumps, auth files, API keys, cookies, or bearer tokens.

### Isolated code execution

Coding workers execute in task-specific worktrees and should receive only the credentials/capabilities required for their profile.

### Explicit elevated actions

Destructive/disruptive actions require stronger confirmation and clear target/consequence display.

## 3. Network model

Preferred setup:

- Hub served only over HTTPS.
- Agent establishes outbound TLS/WebSocket connection.
- Tailscale/private networking used where practical.
- No public SSH/root-shell proxy created by Hub.
- Firewall defaults remain restrictive.

Private networking is not a substitute for authentication; Agent and Hub must still mutually authenticate their logical identities.

## 4. Authentication

### User

Initial release can be single-user, but authentication should still support:

- secure session cookies or equivalent token storage;
- short session lifetime appropriate to control-plane access;
- reauthentication for high-risk operations;
- revocation/logout;
- Android/browser secure storage expectations.

Avoid storing reusable auth tokens in `localStorage` when a more secure cookie/native storage approach is available.

### Agent

Each Agent should use unique machine credentials. Compromising one Agent credential should not impersonate every machine.

Required properties:

- revocable;
- rotatable;
- machine-scoped;
- not committed to repository;
- never printed in normal logs.

## 5. Authorization and capabilities

Use explicit action authorization rather than “admin can execute any string.”

An authorization decision should consider:

- user/session;
- machine;
- requested capability;
- target resource;
- task/run context;
- Agent-local policy;
- whether elevated confirmation is required.

Example:

```text
User authenticated
  AND session permitted remote actions
  AND machine grants service.restart.allowed
  AND target service is allowlisted
  AND request passes replay/expiry checks
  => restart may proceed
```

## 6. Risk levels

Suggested action risk levels:

### READ_ONLY

Examples:

- telemetry;
- logs;
- Git status;
- capacity snapshots;
- repository metadata.

No confirmation beyond normal authenticated session.

### ROUTINE_WRITE

Examples:

- create task worktree;
- run configured tests;
- start a configured dev server;
- create a non-default branch.

Allowed by task policy with full audit trail.

### ELEVATED

Examples:

- kill configured process;
- restart configured service;
- push branch;
- create PR;
- install dependencies when policy permits.

Require explicit UI action or pre-approved bounded task policy.

### DANGEROUS

Examples:

- reboot/shutdown;
- destructive file cleanup;
- force push;
- merge/deploy;
- arbitrary sudo/root action.

Require fresh confirmation/reauthentication and should not be delegated to an autonomous worker by default.

## 7. Request integrity

Remote action requests should include:

- unique request ID;
- machine ID;
- action type;
- target identifier;
- task/run ID when applicable;
- issued timestamp;
- expiry/deadline;
- authorization context/version.

Agent should reject:

- expired requests;
- unknown actions;
- unknown targets;
- mismatched machine IDs;
- missing required run context;
- duplicated non-idempotent request IDs where replay would be dangerous.

## 8. Worker trust model

Treat model output as untrusted instructions.

A worker should not receive broader permissions merely because it can generate commands.

Controls:

- run inside an isolated worktree;
- execute as an unprivileged user;
- restrict repository roots;
- keep destructive Agent capabilities outside worker control;
- provide worker-specific secret set;
- preserve command/tool audit logs where feasible;
- limit runtime/process count/resources when practical;
- require explicit approval for privilege escalation.

Prompt instructions are not a security boundary.

## 9. Repository safety

Agent should enforce:

- allowlisted repository roots/remotes;
- no path traversal outside task workspace;
- no automatic destructive reset of operator checkout;
- no default-branch force push;
- no automatic merge unless explicitly configured later;
- preservation of unpushed changes after crashes/cancellation.

Git operations that affect remote state should be separately capability-gated from local Git operations.

## 10. Secret handling

### Never commit

- provider API keys;
- ChatGPT/Gemini browser/session tokens;
- GitHub private keys/tokens;
- Agent enrollment tokens;
- database passwords;
- push-notification private credentials.

### Prefer locality

If a provider CLI on the Agent is already authenticated, keep that authentication local and expose only normalized data/results to Hub where possible.

### Environment isolation

Worker processes should receive an explicit allowlist of environment variables rather than inheriting the Agent service's entire environment blindly.

### Redaction

Create a shared redaction layer for structured logs. At minimum redact fields named or shaped like:

- authorization;
- token;
- api key;
- password;
- cookie;
- secret;
- private key.

Do not rely only on key names; scan common bearer/token patterns before persisting logs sent to Hub.

## 11. GitHub integration

Prefer GitHub App installation tokens with scoped permissions over long-lived broad personal access tokens.

### Phase 2A minimum read-only permissions

Phase 2A requires strictly read-only GitHub App permissions:

| Permission | Level | Rationale |
| --- | --- | --- |
| **Metadata** | Read-only | Mandatory base permission for repository discovery |
| **Pull Requests** | Read-only | Query open PRs, reviewers, drafts, and CI status |
| **Issues** | Read-only | Query open issues, labels, and attention counters |
| **Actions** | Read-only | Query workflow runs and execution outcomes |
| **Checks** | Read-only | Query check runs and suites for CI status aggregation |
| **Commit statuses** | Read-only | Query legacy commit status contexts for CI aggregation |

**Strictly prohibited in Phase 2A:**
- No write permissions (`contents:write`, `pull_requests:write`, `issues:write`, `actions:write`, etc.) are requested or used.
- No repository administration, webhook management, or organization permissions are requested.
- `Contents: read` is not requested or required in Phase 2A (code/files are never inspected).

### Secret and token handling

- GitHub App private keys (`GITHUB_PRIVATE_KEY`) are kept strictly server-side in the Hub API process.
- Installation access tokens generated by `@octokit/auth-app` are ephemeral (1-hour lifespan), managed in memory, and never persisted to PostgreSQL or logged.
- The browser UI never receives GitHub App credentials or installation tokens; it queries only normalized project and repository summaries through the Hub Fastify API.
- The `packages/github` adapter includes `assertReadOnly()` as an active, defensive runtime invariant checking against developer regression, verifying that no mutating methods have been added to the adapter or source.
- URLs returned in snapshots are checked against safe protocols (`https:`, `http:`) to prevent malicious scheme injection in the UI.


### Webhooks (Phase 2B Implementation)

- **Timing-safe raw-body HMAC-SHA256 verification:** Webhook requests at `POST /github/webhooks` require a valid `X-Hub-Signature-256` header. The signature is computed against the exact unparsed raw request buffer using `crypto.createHmac('sha256', secret)` and compared using `crypto.timingSafeEqual` with an explicit length guard to prevent timing side-channel attacks.
- **Verification precedes JSON parsing:** Verification is executed before JSON decoding or inspection of any payload fields. Requests with missing signatures, invalid hex encodings, or signature mismatches fail immediately with 401 Unauthorized (`github_webhook_invalid_signature`).
- **Secret isolation:** `GITHUB_WEBHOOK_SECRET` is configured independently from GitHub App credentials (`GITHUB_PRIVATE_KEY`). It is server-side only, never transmitted to the browser, never persisted to PostgreSQL, and redacted in logs. If `GITHUB_WEBHOOK_SECRET` is unconfigured, the endpoint returns 503 Service Unavailable (`github_webhook_unconfigured`).
- **Payload untrusted by design:** Webhook payloads are treated as untrusted network inputs and are never executed as commands or stored directly as project truth. Only repository identity (`owner` and `repo`) is extracted to enqueue targeted reconciliation via GitHub's authoritative read APIs.
- **Request bounding:** The webhook route enforces a strict 1 MiB body limit (`bodyLimit: 1_048_576`), rejecting oversized payloads with Fastify's native HTTP 413 before memory exhaustion occurs.
- **Delivery deduplication & replay protection:** Each delivery is tracked by `delivery_id` (`^[a-zA-Z0-9_-]{1,128}$`) using atomic database operations (`INSERT ... ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`). Replayed duplicate deliveries return 202 Accepted without re-triggering reconciliation.
- **Accurate delivery outcome recording:** Deliveries for configured repositories are recorded with `outcome: 'accepted'` and enqueue a targeted refresh. Deliveries for unconfigured repositories, unknown events, pings, or missing envelopes are recorded with `outcome: 'ignored'` and do not trigger reconciliations. All delivery records track both `received_at` and `processed_at`.
- **Audit retention:** Webhook delivery records are retained only for operational debugging and audit, automatically pruned after `GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS` (default 168 hours / 7 days, strictly validated as an integer between 1 and 2160 hours / 90 days on startup).
- **Production TLS assumption:** While raw-body HMAC verification guarantees payload integrity and sender authenticity, production deployments assume TLS termination at the reverse proxy (HTTPS) to safeguard transmissions against packet inspection and replay.

## 12. Provider integrations

Capacity collectors should use the narrowest credentials possible.

Hub should persist:

- normalized metrics;
- safe diagnostic metadata;
- collector status.

Avoid persisting reusable auth tokens when the collector can operate Agent-side and return only metrics.

If raw provider payloads are retained for debugging, apply secret redaction before storage.

For Codex capacity, Hub starts only the configured executable directly as
`codex app-server` with stdio pipes; it does not use `shell: true`. Codex owns
authentication and token refresh. Hub sends one initialization handshake and
read-only account/rate-limit requests, and receives normalized capacity data.
OAuth/access/refresh tokens, auth files, account email/IDs, and raw JSON-RPC
responses are not persisted or exposed to the browser. Stdout is treated as
protocol traffic and stderr is diagnostic text that is bounded and redacted
before optional logging. No Codex login, turn, thread, or reset-credit
redemption endpoint is exposed by Capacity.

## 13. Audit log

Audit events should cover at least:

- user login/logout;
- machine enrollment/revocation;
- capability policy change;
- remote action request/result;
- task dispatch/cancel;
- worker profile selected;
- approval request/result;
- branch push/PR create;
- reboot/shutdown;
- secret/configuration change metadata (never secret values).

Audit events should include actor, action, target, timestamp, result, and related task/run IDs.

## 14. Mobile considerations

Because the Android client can control a development machine:

- support quick logout/revocation;
- require fresh confirmation for DANGEROUS actions;
- do not display secrets in notifications;
- notification deep links must still pass normal authorization;
- consider biometric reauthentication for elevated operations once the basic Capacitor app is stable.

## 15. Failure modes

### Hub compromised

Agent-local policy still limits available commands/targets. Machine credentials can be revoked/rotated after recovery.

### Agent compromised

Treat host as compromised. Revoke machine credential and provider/GitHub credentials reachable from that host. Hub should make machine revocation easy.

### Worker prompt injection

Worker remains limited to its process/user/repository context. It cannot call arbitrary Hub Agent actions unless explicitly granted through a separately secured tool boundary.

### Lost phone

Revoke sessions from another authenticated device/control path. Dangerous actions should require fresh auth/biometric confirmation rather than relying on an indefinitely valid mobile session.

## 16. MVP security checklist

Before remote execution is considered MVP-ready:

- [ ] HTTPS/private transport only.
- [ ] Unique Agent credential.
- [ ] Agent outbound connection.
- [ ] Local capability policy.
- [ ] Repository allowlist.
- [ ] Typed remote actions; no arbitrary command RPC in mobile UI.
- [ ] Unprivileged Agent/worker process where possible.
- [ ] Secrets outside Git.
- [ ] Log redaction.
- [ ] Audit events for remote writes/actions.
- [ ] Expiring/replay-resistant action requests.
- [ ] Worktree isolation.
- [ ] Elevated confirmation for reboot/shutdown/destructive actions.
- [ ] Recovery behavior tested for Agent/Hub/network interruption.
## Phase 1B Agent action boundary

The Hub cannot choose executable commands, filesystem paths, or systemd unit
names. It requests a typed action against a logical target ID. The Agent
resolves that ID against a local, strict policy and may deny the request.

The only initial actions are read-only `repo.status` and disruptive but bounded
user-level `service.restart`. The policy file is local to the Agent, rejects
duplicate IDs, relative repository paths, unsafe service unit syntax, oversized
values, and group/other-writable files. The default missing policy produces a
telemetry-only Agent; an explicitly configured missing or malformed file fails
startup.

Action requests contain no command, arguments, path, unit, shell, or script
field. Subprocesses are fixed Agent code with explicit argv, `shell: false`,
bounded stdout/stderr, and SIGTERM/SIGKILL timeout cleanup. `systemctl` is
always invoked with `--user`; sudo, pkexec, system-level service restart, and
root actions are unsupported.

The policy revision fingerprints normalized target mappings and capabilities.
The Agent checks it before execution, along with the UUID action ID, deadline,
capability, local target resolution, and one-action busy guard. Duplicate IDs
are rejected for the life of the Agent process. Hub persistence and audit
metadata exclude local paths, units, policy JSON, raw command output, and
credentials. There is no automatic action retry after disconnect.

Action audit events are emitted for requested, accepted, denied, succeeded,
failed, timed-out, and interrupted transitions. They contain only action ID,
machine ID, typed action kind, logical target ID, policy revision, status, and a
safe reason/error code. The API exposes only the normalized structured result;
it does not return command output, repository paths, service units, or policy
contents.
