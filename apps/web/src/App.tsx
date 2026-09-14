import { useEffect, useState, type MouseEvent } from 'react';

import type {
  CapacityCurrentProvider,
  CapacityCurrentResponse,
  CapacityResource,
} from '@sonoran-hub/contracts';

import {
  formatTimestamp,
  freshnessLabel,
  providerLabel,
  resourceDetail,
  resourceValue,
  statusLabel,
} from './capacityViewModel.js';

const sections = [
  { label: 'Dashboard', href: '/' },
  { label: 'AI Capacity', href: '/capacity' },
  { label: 'Projects', href: '/#Projects' },
  { label: 'Machines', href: '/#Machines' },
  { label: 'Tasks', href: '/#Tasks' },
];

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000';

interface CapacityState {
  readonly status: 'loading' | 'success' | 'error';
  readonly data?: CapacityCurrentResponse;
  readonly message?: string;
}

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
        {capacity.data ? (
          <span className="updated">API view {formatTimestamp(capacity.data.generatedAt)}</span>
        ) : null}
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
    <section className={compact ? 'provider-grid compact-grid' : 'provider-grid'}>
      {state.data.providers.map((provider) => (
        <ProviderCard compact={compact} key={provider.providerId} provider={provider} />
      ))}
    </section>
  );
}

function ProviderCard({
  provider,
  compact,
}: {
  provider: CapacityCurrentProvider;
  compact: boolean;
}) {
  const resources = provider.snapshot?.resources ?? [];
  const primary = resources.find((resource) => resource.kind === 'wallet') ?? resources[0];
  const hasUnknown = resources.some((resource) => resource.status === 'unknown');
  const unavailable = provider.health.available === false && !provider.snapshot;
  const providerState = unavailable
    ? 'Provider unavailable'
    : hasUnknown
      ? 'Partial provider data'
      : 'Provider data available';

  return (
    <article className="provider-card">
      <div className="provider-card-heading">
        <div>
          <p className="eyebrow">Provider</p>
          <h3>{providerLabel(provider.providerId)}</h3>
        </div>
        <span className={`state-badge ${unavailable ? 'badge-unknown' : 'badge-available'}`}>
          {providerState}
        </span>
      </div>

      {compact ? (
        <div className="compact-summary">
          <strong>{primary ? resourceValue(primary) : 'No data yet'}</strong>
          {resources
            .filter((resource) => resource.kind === 'pricing_window')
            .map((resource) => (
              <span key={resource.id}>{resourceValue(resource)}</span>
            ))}
        </div>
      ) : (
        <div className="resource-list">
          {resources.length === 0 ? (
            <p className="muted">
              No snapshot yet. The API will show data after a collection succeeds.
            </p>
          ) : (
            resources.map((resource) => <ResourceRow key={resource.id} resource={resource} />)
          )}
        </div>
      )}

      <div className="provider-footer">
        <span>
          {provider.snapshot
            ? `Updated ${formatTimestamp(provider.snapshot.collectedAt)}`
            : (provider.health.lastError?.message ?? 'Waiting for first collection')}
        </span>
        {provider.health.lastProbeFailure ? (
          <span className="footer-warning">Probe: {provider.health.lastProbeFailure.message}</span>
        ) : null}
      </div>
    </article>
  );
}

function ResourceRow({ resource }: { resource: CapacityResource }) {
  const detail = resourceDetail(resource);
  return (
    <div className="resource-row">
      <div className="resource-heading">
        <strong>{resource.name}</strong>
        <div className="resource-tags">
          <span className={`status-text status-${resource.status}`}>
            {statusLabel(resource.status)}
          </span>
          <span className={`freshness-text freshness-${resource.freshness}`}>
            {freshnessLabel(resource.freshness)}
          </span>
        </div>
      </div>
      <strong className="resource-value">{resourceValue(resource)}</strong>
      {detail ? <span className="resource-detail">{detail}</span> : null}
      {resource.error ? <span className="resource-error">{resource.error.message}</span> : null}
    </div>
  );
}

function useCapacity(): CapacityState {
  const [state, setState] = useState<CapacityState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`${apiBaseUrl}/capacity`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('The Hub API did not return capacity data.');
        }
        return (await response.json()) as CapacityCurrentResponse;
      })
      .then((data) => setState({ status: 'success', data }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'The capacity request failed.',
        });
      });
    return () => controller.abort();
  }, []);

  return state;
}
