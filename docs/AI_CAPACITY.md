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

## 6. ChatGPT / Codex

### Desired resources

- Primary rolling quota window.
- Secondary/weekly quota window where exposed.
- Remaining/used percentages.
- Reset timestamps.
- Additional metered buckets where exposed.
- Reset credits or other capacity recovery state when available.

### Collection strategy

Prefer a local Agent-side integration with the authenticated Codex app-server rather than extracting browser cookies or copying raw ChatGPT credentials to Hub.

The adapter boundary should hide the exact Codex protocol from the rest of Sonoran Hub. Version-pin and integration-test against known Codex versions because this is an evolving client protocol.

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
