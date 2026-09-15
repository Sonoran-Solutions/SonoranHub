# AI Capacity Dashboard

The AI Capacity subsystem exists to answer a practical routing question:

> **What AI resources are actually available right now, what will they cost, and which ones should Sonoran Hub preserve or use?**

It is not a generic provider billing product. It is a decision-support input for the Sonoran workflow.

## 1. Core design rule

Do **not** normalize every provider into one `remainingPercent` field.

These are materially different resources:

- ChatGPT/Codex rolling and weekly quota windows.
- Gemini model quota/refresh windows.
- DeepSeek API cash balance.
- DeepSeek peak/off-peak pricing state.
- OpenRouter account credit.
- OpenRouter API-key budget.

The data model must preserve those semantics.

## 2. Normalized model

Suggested first contract:

```ts
export type CapacityKind =
  | "rolling_quota"
  | "weekly_quota"
  | "wallet"
  | "key_budget"
  | "pricing_window"
  | "credits"
  | "concurrency";

export type CapacityStatus =
  | "available"
  | "warning"
  | "critical"
  | "exhausted"
  | "unknown";

export interface CapacityResource {
  id: string;
  provider: string;
  accountRef?: string;
  kind: CapacityKind;
  name: string;

  limit?: number;
  used?: number;
  remaining?: number;
  remainingPercent?: number;

  unit:
    | "percent"
    | "usd"
    | "credits"
    | "requests"
    | "tokens"
    | "connections"
    | "state";

  resetAt?: string;
  changesAt?: string;

  status: CapacityStatus;
  source:
    | "official_api"
    | "official_cli"
    | "local_state"
    | "derived";

  collectedAt: string;
  staleAfter?: string;
  metadata?: Record<string, unknown>;
}
```

Provider-specific raw payloads should be persisted separately or in a versioned metadata envelope for diagnostics. The UI should rely on normalized fields.

## 3. Provider adapter contract

Each collector should implement an adapter boundary similar to:

```ts
interface CapacityProviderAdapter {
  id: string;
  probe(): Promise<AdapterAvailability>;
  collect(): Promise<CapacityCollectionResult>;
}
```

`collect()` returns either normalized resources or a typed collector error. One failed adapter must not prevent snapshots from other providers.

## 4. OpenRouter

### Desired resources

- Account credit/remaining wallet where available.
- Key-level configured budget and remaining amount.
- Daily/weekly/monthly usage when exposed.
- Reset timing when the key budget has a reset policy.

### Collection strategy

Prefer official OpenRouter endpoints. Keep account-level and API-key-level resources distinct.

### UI example

```text
OpenRouter
Credits            $18.42 remaining
API key budget     $6.58 / $25.00 used
This month         $6.58
```

Do not infer a reset date if the provider does not return one.

### Current implementation

The OpenRouter adapter uses only the official `GET /api/v1/key` and
`GET /api/v1/credits` endpoints. `OPENROUTER_API_KEY` enables the current-key
probe and the `key_budget` resource. `OPENROUTER_MANAGEMENT_KEY` is a separate,
optional credential that enables the account-level credit resource; it is never
substituted with the normal API key.

The key resource uses provider-reported `limit_remaining` when a limit is
configured. `limit_reset` is retained as metadata and is not converted into an
invented `resetAt` timestamp. An uncapped key is represented as a freshly
observed `key_budget` resource with `status: "unknown"` and metadata marking it
as unbounded; no artificial limit or percentage is created.

If the management-key request fails after the key request succeeds, the key
resource remains usable and the account-credit resource is marked unknown with
a safe resource-level error. If no management key is configured, the optional
account-credit resource is omitted. This preserves the D1 result shape without
discarding a known-good key budget.

Normal tests inject a fetch-compatible function and make no OpenRouter network
calls. An opt-in developer smoke test uses the real adapter and read-only
endpoints:

```bash
OPENROUTER_API_KEY=... OPENROUTER_MANAGEMENT_KEY=... pnpm smoke:openrouter
```

The management key may be omitted; the smoke test then exercises key-level
collection only. The command never submits a model completion and prints only
normalized, non-secret data.

Each OpenRouter HTTP request has its own finite timeout (5 seconds by default)
and aborts the underlying fetch when that timeout expires. This is independent
of the D1 coordinator's outer collection timeout, so a timed-out optional
credits request does not discard a valid key-budget resource.

## 5. DeepSeek

DeepSeek should expose at least two independent concepts:

### Balance

Collect current official account balance and represent it as a `wallet` resource.

### Pricing window

Represent current peak/off-peak state as a `pricing_window` resource, including the next transition time.

The dashboard should be able to say:

```text
DeepSeek
Balance      $14.82
Pricing      OFF-PEAK
Changes      peak pricing in 3h 11m
```

### DeepSeekBudget reference

The project at:

https://github.com/FAAATQ/DeepSeekBudget

is a useful reference implementation for DeepSeek peak/off-peak schedule handling. Its schedule engine is intentionally separated from its Tauri UI. Sonoran Hub should reuse the design idea rather than embed the desktop application.

If Sonoran Hub copies or adapts MIT-licensed source code from DeepSeekBudget, preserve the required copyright/license notice and document the copied components. If Hub independently implements public provider pricing rules, keep a source URL and `verifiedAt` timestamp in the pricing configuration.

### Pricing configuration

Keep provider pricing data/config separate from scheduling code. Suggested shape:

```json
{
  "provider": "deepseek",
  "verifiedAt": "YYYY-MM-DD",
  "schedule": {},
  "models": []
}
```

Pricing configuration should be refreshable without rewriting the dashboard UI.

### Current implementation

The DeepSeek adapter uses the official read-only `GET
https://api.deepseek.com/user/balance` endpoint with `DEEPSEEK_API_KEY`. The
balance response is validated before strict decimal-string conversion. USD is
represented as a `wallet` resource without an invented limit, usage, reset, or
percentage. CNY is never converted into USD; when present alongside USD it is
retained in safe metadata, and a CNY-only response leaves the USD wallet
unknown rather than mislabeling it.

The pricing-window resource is derived independently from versioned UTC
configuration verified against the official pricing documentation. It reports
`PEAK` or `OFF_PEAK`, the current multiplier, provenance, and the exact next
transition timestamp. The schedule uses half-open windows: Monday–Friday
01:00–04:00 UTC and 06:00–10:00 UTC are peak; all other times are off-peak.

Balance collection and pricing derivation remain independent. A failed balance
request does not discard a known pricing window, and an invalid pricing
configuration does not discard a valid wallet. Each balance request has its
own finite timeout (5 seconds by default) and aborts the underlying fetch;
the D1 coordinator timeout remains the outer safety boundary.

Normal tests use injected fetch implementations and make no DeepSeek network
calls. An opt-in live smoke test is available:

```bash
DEEPSEEK_API_KEY=... pnpm smoke:deepseek
```

It performs only the balance probe/collection, never an inference request, and
prints sanitized normalized resources.

## 6. ChatGPT / Codex

### Desired resources

- Primary rolling quota window.
- Secondary/weekly quota window where exposed.
- Remaining/used percentages.
- Reset timestamps.
- Additional metered buckets where exposed.
- Reset credits or other capacity recovery state when available.

### Collection strategy

The current Hub-local collector uses the official authenticated local `codex
app-server` over stdio. It does not scrape ChatGPT, read browser cookies, call
private HTTP endpoints, parse the Codex TUI, or copy OAuth credentials into Hub.
The browser never talks to Codex directly. Collection remains in the Hub API
until Sonoran Agent exists; the `CodexCapacitySource` boundary is deliberately
transport-neutral so the same source can move behind Agent later.

The source lazily starts one reusable `codex app-server` child per API runtime,
performs the official `initialize` / `initialized` handshake, and reads
`account/read` with `refreshToken: false` followed by
`account/rateLimits/read`. Startup, initialize, request, and shutdown all have
finite timeouts. A failed or exited child is discarded and a later refresh may
start one replacement; the API closes the child during shutdown. Stdout is
JSONL protocol traffic, stderr is bounded/redacted diagnostics only.
Sparse `account/rateLimits/updated` notifications are parsed as notifications
and ignored for state mutation in this first slice; the existing 60-second
poll remains the only refresh trigger, so notifications cannot create
overlapping reads.

The adapter boundary hides the exact evolving Codex protocol from the rest of
Sonoran Hub. The local CLI version is retained only as safe collector metadata
when the app-server exposes it.

Set `CODEX_BIN` in the server/API environment to override the executable path;
the default is `codex`. This is not a Vite/browser variable. The local CLI must
already be authenticated to an appropriate ChatGPT-backed Codex account. An
API-key-only or unsupported provider-mode account is reported unavailable for
this subscription-capacity adapter.

The read-only developer smoke test is opt-in:

```bash
pnpm smoke:codex
```

It performs no inference, thread, turn, login, logout, or reset-credit
redemption and prints only sanitized normalized fields.

### Normalization

`rateLimitsByLimitId` is preferred and the legacy `rateLimits` view is used as
a non-duplicating fallback. Primary and secondary windows become separate
resources. Primary is `rolling_quota`; secondary is `weekly_quota` only when
Codex reports exactly 10080 minutes. All other durations remain
`rolling_quota`, and display names are generated from the actual duration.
`usedPercent` is validated and inverted to remaining capacity; reset Unix
seconds are stored as ISO-8601 UTC. Additional limit buckets retain safe
provider names/model slugs in metadata.

`ordinaryUsageAllowed`, `rateLimitReachedType`, and spend-control state are
preserved in metadata and affect presentation status. Credits are not assumed
to be USD. The optional spend-control snapshot exposes only validated percent
and reset semantics while retaining its raw amount strings as provider
metadata. Available reset credits use the authoritative `availableCount`; the
detail rows and opaque IDs are never sent to the browser.

Codex provider resources use `source: official_cli`. No database migration is
required: successful normalized results use the existing
`CapacityService → CapacitySnapshotStore → PostgreSQL` pipeline and appear in
`GET /capacity` and `GET /capacity/history?provider=codex`.

### Security rule

Hub should receive normalized quota state, not reusable authentication tokens.

## 7. Gemini

Gemini is expected to be the least stable initial collector.

### Adapter requirement

Define the `GeminiCapacitySource` boundary before writing collection logic.

Preferred source order:

1. official structured API;
2. official headless CLI output/state;
3. reliable local state exposed by the official client;
4. temporary parsing workaround only if necessary.

If a workaround is used, mark its source type and confidence clearly. Do not let the UI treat experimental data as authoritative.

## 8. Snapshot persistence

Store snapshots over time so the dashboard can answer more than “right now.”

The first implementation stores immutable normalized observations in
PostgreSQL using the `capacity_snapshots` table. The Capacity service validates
and redacts a collection result before saving it through the narrow
`CapacitySnapshotStore` boundary. A partial result is still a valid snapshot;
for example, an unknown DeepSeek wallet is stored alongside an available
pricing window. Raw provider response bodies, Authorization headers, and
credentials are never stored.

Apply schema changes explicitly with `pnpm db:migrate`; the API does not run
migrations during normal startup. Snapshots are returned newest first from
`GET /capacity/history`, with a maximum page size of 100. The current endpoint
is `GET /capacity` and returns one latest snapshot per registered provider,
plus safe provider health information.

Runtime refresh cadence is intentionally split between providers and the UI:

- provider adapters refresh independently every 60 seconds by default, controlled by `CAPACITY_REFRESH_INTERVAL_MS`;
- the browser polls the Hub API every 15 seconds for persisted snapshots;
- the browser never calls DeepSeek or OpenRouter directly, and a page refresh does not trigger provider API requests.

Recommended fields:

- provider/source ID;
- resource ID;
- normalized values;
- collection timestamp;
- source type;
- stale/error state;
- provider payload version/hash;
- raw payload reference where retained.

### Retention

Do not store every minute forever. Start with simple retention/downsampling, for example:

- high-resolution recent history;
- hourly samples for older data;
- daily summary for long-term analytics.

Exact intervals can be tuned after real usage exists.

## 9. Staleness rules

A collector result has three distinct states:

- **fresh:** most recent collection succeeded and is inside the expected refresh interval;
- **stale:** last successful value exists but recent collection failed/expired;
- **unknown:** no trustworthy value has ever been collected.

Never map stale or unknown to zero.

The API stamps successful fresh resources with a conservative stale-after
interval and derives a stale presentation state when that timestamp has
passed. Historical rows remain immutable observations.

Example:

```text
Gemini Pro
55% remaining
Last updated 42m ago ⚠ collector unavailable
```

is materially different from:

```text
Gemini Pro
0% remaining
```

## 10. Dashboard UX

### Home cards

Compact provider cards should show only the next decision-relevant facts:

- status;
- most important remaining resource;
- next reset/change;
- stale warning.

### Full Capacity view

The full view should show:

- all normalized resources;
- exact reset/change timestamps;
- history chart;
- current collector health;
- source type;
- last successful refresh;
- provider-specific details behind an expand section.

## 11. Routing integration

The Orchestrator should consume normalized capacity as one input, never as the only input.

Example policy signals:

```text
Task difficulty           hard
Preferred model           GPT premium profile
ChatGPT 5h remaining      13%
ChatGPT reset             3h 42m
DeepSeek                  off-peak
DeepSeek wallet           healthy
Gemini quota              high
```

Possible router result:

```text
Use DeepSeek Pro for initial investigation.
Reserve ChatGPT capacity for final review/escalation.
```

Every recommendation should persist its inputs and explanation so later analytics can tell whether the decision was useful.

## 12. Burn-rate forecasting

Once enough snapshots exist, add derived signals such as:

- consumption per hour;
- predicted exhaustion before reset;
- unusually fast burn;
- projected API spend this month;
- cheapest upcoming pricing window for deferrable work.

Forecasts must be labeled derived/estimated and should never overwrite provider-reported values.

## 13. Initial implementation order

1. Normalized contracts and fixture tests.
2. OpenRouter collector.
3. DeepSeek balance collector.
4. DeepSeek pricing-window engine with boundary tests.
5. Snapshot persistence.
6. Capacity dashboard.
7. ChatGPT/Codex collector.
8. Gemini collector.
9. Historical charts and burn-rate forecast.
10. Feed capacity into Orchestrator policy.
