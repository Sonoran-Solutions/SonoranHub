import { useEffect, useState, type MouseEvent } from 'react';

import type {
  CapacityCurrentProvider,
  CapacityCurrentResponse,
  CapacityResource,
} from '@sonoran-hub/contracts';

import {
  createCapacityPoller,
  codexMainQuotaResources,
  codexPlanLabel,
  deepSeekPricingPresentation,
  geminiCompactQuotaResources,
  geminiPlanLabel,
  formatRelativeAge,
  freshnessLabel,
  formatPercent,
  formatRelativeReset,
  initialCapacityState,
  primaryResource,
  providerLabel,
  providerSummaryStatus,
  resourceDetail,
  resourceStatusLabel,
  resourceValue,
  isDisabledResource,
  type CapacityState,
} from './capacityViewModel.js';

const sections = [
  { label: 'Dashboard', href: '/' },
  { label: 'AI Capacity', href: '/capacity' },
  { label: 'Projects', href: '/#Projects' },
  { label: 'Machines', href: '/#Machines' },
  { label: 'Tasks', href: '/#Tasks' },
];

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000';

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const handleNavigation = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handleNavigation);
    return () => window.removeEventListener('popstate', handleNavigation);
  }, []);

  const onNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute('href');
    if (!href || !href.startsWith('/') || href.includes('#')) {
      return;
    }
    event.preventDefault();
    window.history.pushState({}, '', href);
    setPath(href);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sonoran Solutions</p>
          <h1>Sonoran Hub</h1>
        </div>
        <span className="status-pill">Capacity live slice</span>
      </header>

      <div className="workspace">
        <nav aria-label="Primary navigation" className="sidebar">
          {sections.map((section) => (
            <a
              className={path === section.href ? 'nav-item active' : 'nav-item'}
              href={section.href}
              key={section.label}
              onClick={onNavigate}
            >
              {section.label}
            </a>
          ))}
        </nav>

        {path === '/capacity' ? <CapacityPage /> : <HomePage />}
      </div>
    </div>
  );
}

function HomePage() {
  const capacity = useCapacity();
  return (
    <main className="content">
      <section className="hero">
        <p className="eyebrow">Control plane</p>
        <h2>A calm place to see what needs your attention.</h2>
        <p>
          Sonoran Hub is the control plane for Sonoran Solutions development workflows. Capacity is
          the first live surface, with provider credentials kept entirely on the API.
        </p>
      </section>
      <section aria-labelledby="home-capacity-title" className="home-capacity">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Decision support</p>
            <h2 id="home-capacity-title">AI Capacity</h2>
          </div>
          <a className="text-link" href="/capacity">
            Open full view →
          </a>
        </div>
        <CapacityStateView state={capacity} compact />
      </section>
    </main>
  );
}

function CapacityPage() {
  const capacity = useCapacity();
  return (
    <main className="content">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Decision support</p>
          <h2>AI Capacity</h2>
          <p>Normalized provider information collected by Sonoran Hub.</p>
        </div>
        <span className="updated">Hub API polls every 15s</span>
      </section>
      <CapacityStateView state={capacity} />
    </main>
  );
}

function CapacityStateView({
  state,
  compact = false,
}: {
  state: CapacityState;
  compact?: boolean;
}) {
  const now = useCurrentTime();
  if (state.status === 'loading') {
    return <div className="state-panel">Loading capacity…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="state-panel state-error" role="alert">
        <strong>Capacity API unavailable</strong>
        <span>{state.message}</span>
      </div>
    );
  }
  if (!state.data || state.data.providers.length === 0) {
    return <div className="state-panel">No capacity providers are registered yet.</div>;
  }
  return (
    <>
      <CapacityRefreshStatus state={state} />
      <section className={compact ? 'provider-grid compact-grid' : 'provider-grid'}>
        {state.data.providers.map((provider) => (
          <ProviderCard compact={compact} key={provider.providerId} now={now} provider={provider} />
        ))}
      </section>
    </>
  );
}

function CapacityRefreshStatus({ state }: { state: CapacityState }) {
  if (state.status !== 'success' || (!state.refreshing && !state.refreshError)) {
    return null;
  }
  return (
    <p className="refresh-status" role="status">
      {state.refreshing ? 'Updating…' : `Update failed: ${state.refreshError}`}
    </p>
  );
}

function ProviderCard({
  provider,
  compact,
  now,
}: {
  provider: CapacityCurrentProvider;
  compact: boolean;
  now: number;
}) {
  const resources = provider.snapshot?.resources ?? [];
  const primary = primaryResource(resources);
  const codexMainQuotas = codexMainQuotaResources(resources);
  const geminiQuotas = geminiCompactQuotaResources(resources);
  const plan =
    provider.providerId === 'gemini' ? geminiPlanLabel(resources) : codexPlanLabel(resources);
  const pricing =
    provider.providerId === 'deepseek'
      ? deepSeekPricingPresentation(
          resources.find((resource) => resource.kind === 'pricing_window'),
        )
      : undefined;
  const unavailable = provider.health.available === false && !provider.snapshot;
  const summaryStatus = providerSummaryStatus(resources, unavailable);
  const providerState =
    summaryStatus === 'unavailable'
      ? 'Provider unavailable'
      : summaryStatus === 'partial'
        ? 'Partial provider data'
        : 'Provider data available';

  return (
    <article className="provider-card">
      <div className="provider-card-heading">
        <div>
          <p className="eyebrow">Provider</p>
          <h3>{providerLabel(provider.providerId)}</h3>
        </div>
        <div className="provider-badges">
          {plan ? <span className="plan-badge">{plan}</span> : null}
          {pricing ? (
            <span className={`pricing-badge pricing-${pricing.tone}`}>{pricing.badge}</span>
          ) : null}
          <span
            className={`state-badge ${
              summaryStatus === 'unavailable'
                ? 'badge-unknown'
                : summaryStatus === 'partial'
                  ? 'badge-warning'
                  : 'badge-available'
            }`}
          >
            {providerState}
          </span>
        </div>
      </div>

      {compact ? (
        provider.providerId === 'codex' ? (
          <div className="compact-summary">
            {codexMainQuotas.length > 0 ? (
              <div className="compact-quota-list">
                {codexMainQuotas.map((resource) => (
                  <div className="compact-quota" key={resource.id}>
                    <span>{resource.name}</span>
                    <strong>{formatPercent(resource.remainingPercent)}</strong>
                    {resource.resetAt ? (
                      <small>{`Resets ${formatRelativeReset(resource.resetAt, now)}`}</small>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <strong>No data yet</strong>
            )}
          </div>
        ) : provider.providerId === 'gemini' ? (
          <div className="compact-summary">
            {geminiQuotas.length > 0 ? (
              <div className="compact-quota-list">
                {geminiQuotas.map((resource) => (
                  <div className="compact-quota" key={resource.id}>
                    <span>{resource.name}</span>
                    <strong>{formatPercent(resource.remainingPercent)}</strong>
                    {resource.resetAt ? (
                      <small>{`Resets ${formatRelativeReset(resource.resetAt, now)}`}</small>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <strong>No active quota data yet</strong>
            )}
          </div>
        ) : (
          <div className="compact-summary">
            <strong>{primary ? resourceValue(primary) : 'No data yet'}</strong>
            {primary?.kind === 'wallet' && primary.remainingPercent !== undefined ? (
              <span>{formatPercent(primary.remainingPercent)} of credits</span>
            ) : null}
            {pricing ? <span>{pricing.summary}</span> : null}
          </div>
        )
      ) : (
        <div className="resource-list">
          {resources.length === 0 ? (
            <p className="muted">
              No snapshot yet. The API will show data after a collection succeeds.
            </p>
          ) : (
            resources.map((resource) => (
              <ResourceRow key={resource.id} now={now} resource={resource} />
            ))
          )}
        </div>
      )}

      <div className="provider-footer">
        <span>
          {provider.snapshot
            ? `Updated ${formatRelativeAge(provider.snapshot.collectedAt, now)}`
            : (provider.health.lastError?.message ?? 'Waiting for first collection')}
        </span>
        {provider.snapshot ? <span>Refreshes every 1 min</span> : null}
        {provider.snapshot?.freshness === 'stale' ? (
          <span className="footer-warning">STALE snapshot</span>
        ) : null}
        {provider.health.lastProbeFailure ? (
          <span className="footer-warning">Probe: {provider.health.lastProbeFailure.message}</span>
        ) : null}
      </div>
    </article>
  );
}

function ResourceRow({ resource, now }: { resource: CapacityResource; now: number }) {
  const detail = resourceDetail(resource, now);
  return (
    <div className="resource-row">
      <div className="resource-heading">
        <strong>{resource.name}</strong>
        <div className="resource-tags">
          <span
            className={`status-text ${
              resourceStatusLabel(resource) === 'UNBOUNDED'
                ? 'status-unbounded'
                : `status-${resource.status}`
            }`}
          >
            {resourceStatusLabel(resource)}
          </span>
          <span className={`freshness-text freshness-${resource.freshness}`}>
            {freshnessLabel(resource.freshness)}
          </span>
        </div>
      </div>
      <strong className="resource-value">{resourceValue(resource)}</strong>
      {resource.remainingPercent !== undefined && !isDisabledResource(resource) ? (
        <div
          aria-label={`${formatPercent(resource.remainingPercent)} remaining`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={resource.remainingPercent}
          className={`capacity-bar capacity-bar-${resource.status}`}
          role="progressbar"
        >
          <span style={{ width: `${resource.remainingPercent}%` }} />
        </div>
      ) : null}
      {detail ? <span className="resource-detail">{detail}</span> : null}
      {resource.error ? <span className="resource-error">{resource.error.message}</span> : null}
    </div>
  );
}

function useCapacity(): CapacityState {
  const [state, setState] = useState<CapacityState>(initialCapacityState);

  useEffect(() => {
    const poller = createCapacityPoller({
      fetchCapacity: (signal) => fetchCapacity(signal),
      onState: setState,
    });
    poller.start();
    return () => poller.stop();
  }, []);

  return state;
}

async function fetchCapacity(signal: AbortSignal): Promise<CapacityCurrentResponse> {
  const response = await fetch(`${apiBaseUrl}/capacity`, { signal });
  if (!response.ok) {
    throw new Error('The Hub API did not return capacity data.');
  }
  return (await response.json()) as CapacityCurrentResponse;
}

function useCurrentTime(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
