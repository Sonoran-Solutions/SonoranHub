import { useEffect, useState, type Dispatch, type MouseEvent, type SetStateAction } from 'react';

import type {
  CapacityCurrentProvider,
  CapacityCurrentResponse,
  CapacityResource,
  MachineActionInput,
  MachineActionRecord,
  MachineSummary,
  MachinesResponse,
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
  { label: 'Machines', href: '/machines' },
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
        <span className="status-pill">Agent foundation live</span>
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

        {path === '/capacity' ? (
          <CapacityPage />
        ) : path === '/machines' ? (
          <MachinesPage />
        ) : (
          <HomePage />
        )}
      </div>
    </div>
  );
}

function HomePage() {
  const capacity = useCapacity();
  const machines = useMachines();
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
      <section aria-labelledby="home-machines-title" className="home-machines">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Trusted hosts</p>
            <h2 id="home-machines-title">Machines</h2>
          </div>
          <a className="text-link" href="/machines">
            Open full view →
          </a>
        </div>
        <HomeMachineSummary state={machines} />
      </section>
    </main>
  );
}

function HomeMachineSummary({ state }: { state: MachinesState }) {
  if (state.status === 'loading') return <div className="state-panel">Loading machines…</div>;
  if (state.status === 'error') {
    return <div className="state-panel state-error">Machine data is unavailable.</div>;
  }
  if (state.data.machines.length === 0) {
    return <div className="state-panel">No Agent enrolled yet.</div>;
  }
  return (
    <>
      {state.refreshError ? (
        <p className="refresh-status" role="status">
          Showing the last successful machine update. Refresh failed.
        </p>
      ) : null}
      <div className="home-machine-list">
        {state.data.machines.slice(0, 3).map((machine) => (
          <div className="home-machine-row" key={machine.identity.id}>
            <strong>{machine.identity.name}</strong>
            <span className={`machine-status machine-status-${machine.status.toLowerCase()}`}>
              {machine.status}
            </span>
            <small>
              CPU {formatPercentValue(machine.telemetry?.cpuPercent)} · RAM{' '}
              {machine.telemetry?.memoryUsedBytes !== undefined &&
              machine.telemetry.memoryTotalBytes !== undefined
                ? `${formatBytes(machine.telemetry.memoryUsedBytes)} / ${formatBytes(machine.telemetry.memoryTotalBytes)}`
                : 'Unavailable'}{' '}
              · Seen {formatMachineAge(machine.lastSeenAt)}
            </small>
          </div>
        ))}
      </div>
    </>
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

function MachinesPage() {
  const state = useMachines();
  return (
    <main className="content">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Trusted hosts</p>
          <h2>Machines</h2>
          <p>Live state and bounded telemetry from outbound Sonoran Agents.</p>
        </div>
        <span className="updated">Refreshes every 5s</span>
      </section>
      {state.status === 'loading' ? <div className="state-panel">Loading machines…</div> : null}
      {state.status === 'error' ? (
        <div className="state-panel state-error" role="alert">
          <strong>Machine API unavailable</strong>
          <span>{state.message}</span>
        </div>
      ) : null}
      {state.status === 'success' && state.data.machines.length === 0 ? (
        <div className="state-panel">
          No Agent is connected yet. Start the Agent with SONORAN_HUB_URL and SONORAN_AGENT_TOKEN
          configured.
        </div>
      ) : null}
      {state.status === 'success' && state.refreshError ? (
        <p className="refresh-status" role="status">
          Showing the last successful machine update. Refresh failed: {state.refreshError}
        </p>
      ) : null}
      {state.status === 'success' ? (
        <section className="machine-grid">
          {state.data.machines.map((machine) => (
            <MachineCard key={machine.identity.id} machine={machine} />
          ))}
        </section>
      ) : null}
    </main>
  );
}

function MachineCard({ machine }: { machine: MachineSummary }) {
  const [actions, setActions] = useState<Record<string, MachineActionRecord>>({});
  const [confirmingService, setConfirmingService] = useState<string | undefined>();
  useEffect(() => {
    let disposed = false;
    const loadActions = async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/machines/${encodeURIComponent(machine.identity.id)}/actions`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as { actions?: MachineActionRecord[] };
        if (disposed || !Array.isArray(body.actions)) return;
        setActions((previous) => {
          const next = { ...previous };
          for (const action of body.actions ?? []) {
            next[`${action.kind}:${action.targetId}`] = action;
          }
          return next;
        });
      } catch {
        // The machine card keeps its last known action result during polling gaps.
      }
    };
    void loadActions();
    const timer = window.setInterval(() => void loadActions(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [machine.identity.id]);
  const memory =
    machine.telemetry?.memoryTotalBytes !== undefined
      ? `${formatBytes(machine.telemetry.memoryUsedBytes ?? 0)} / ${formatBytes(machine.telemetry.memoryTotalBytes)}`
      : 'Unavailable';
  const rootDisk =
    machine.telemetry?.disks.find((disk) => disk.id === '/') ?? machine.telemetry?.disks[0];
  return (
    <article className="machine-card">
      <div className="machine-heading">
        <div>
          <p className="eyebrow">Machine</p>
          <h3>{machine.identity.name}</h3>
          <span className="machine-platform">
            {machine.identity.platform} · {machine.identity.arch}
          </span>
        </div>
        <span className={`machine-status machine-status-${machine.status.toLowerCase()}`}>
          {machine.status}
        </span>
      </div>
      <div className="machine-meta">
        <div>
          <span>Agent</span>
          <strong>{machine.agentVersion}</strong>
        </div>
        <div>
          <span>Last seen</span>
          <strong>{formatMachineAge(machine.lastSeenAt)}</strong>
        </div>
        <div>
          <span>CPU</span>
          <strong>{formatPercentValue(machine.telemetry?.cpuPercent)}</strong>
        </div>
        <div>
          <span>RAM</span>
          <strong>{memory}</strong>
        </div>
        <div>
          <span>Disk {rootDisk?.id ?? '/'}</span>
          <strong>
            {rootDisk
              ? `${formatBytes(rootDisk.usedBytes)} / ${formatBytes(rootDisk.totalBytes)}`
              : 'Unavailable'}
          </strong>
        </div>
        <div>
          <span>Uptime</span>
          <strong>{formatUptime(machine.telemetry?.uptimeSeconds)}</strong>
        </div>
      </div>
      <div className="machine-footer">
        <span>
          {machine.capabilities.length} capability{machine.capabilities.length === 1 ? '' : 'ies'}
        </span>
        <span>Protocol v{machine.protocolVersion}</span>
        <span>{machine.identity.id}</span>
      </div>
      <section aria-labelledby={`${machine.identity.id}-actions`} className="machine-actions">
        <div className="action-section-heading">
          <div>
            <p className="eyebrow">Typed remote actions</p>
            <h4 id={`${machine.identity.id}-actions`}>Local policy targets</h4>
          </div>
          <span className="muted">Agent decides locally</span>
        </div>
        {machine.actionCatalog.repositories.length === 0 &&
        machine.actionCatalog.services.length === 0 ? (
          <p className="muted">No remote action targets are advertised by this Agent.</p>
        ) : null}
        <div className="action-target-list">
          {machine.actionCatalog.repositories.map((target) => (
            <ActionTargetRow
              action={actions[`repo.status:${target.id}`]}
              disabled={machine.status !== 'ONLINE'}
              key={`repo.status:${target.id}`}
              label={target.label}
              onAction={() =>
                void submitMachineAction(
                  machine.identity.id,
                  { kind: 'repo.status', targetId: target.id },
                  setActions,
                )
              }
              resultLabel={repoStatusLabel(actions[`repo.status:${target.id}`])}
              title="Repository"
              actionLabel="Check status"
            />
          ))}
          {machine.actionCatalog.services.map((target) => {
            const key = `service.restart:${target.id}`;
            const action = actions[key];
            return (
              <div className="action-target" key={key}>
                <div>
                  <span className="action-target-kind">Service</span>
                  <strong>{target.label}</strong>
                </div>
                {confirmingService === target.id ? (
                  <div
                    className="action-confirmation"
                    role="alertdialog"
                    aria-label={`Restart ${target.label}`}
                  >
                    <strong>Restart {target.label}?</strong>
                    <span>This will temporarily interrupt the configured user service.</span>
                    <div className="action-buttons">
                      <button
                        className="button button-muted"
                        onClick={() => setConfirmingService(undefined)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="button button-danger"
                        disabled={machine.status !== 'ONLINE' || actionIsActive(action)}
                        onClick={() => {
                          setConfirmingService(undefined);
                          void submitMachineAction(
                            machine.identity.id,
                            { kind: 'service.restart', targetId: target.id },
                            setActions,
                          );
                        }}
                        type="button"
                      >
                        Restart
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="button button-danger"
                    disabled={machine.status !== 'ONLINE' || actionIsActive(action)}
                    onClick={() => setConfirmingService(target.id)}
                    type="button"
                  >
                    Restart
                  </button>
                )}
                {action ? (
                  <ActionResult action={action} resultLabel={serviceStatusLabel(action)} />
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </article>
  );
}

function ActionTargetRow({
  action,
  actionLabel,
  disabled,
  label,
  onAction,
  resultLabel,
  title,
}: {
  action: MachineActionRecord | undefined;
  actionLabel: string;
  disabled: boolean;
  label: string;
  onAction: () => void;
  resultLabel: string | undefined;
  title: string;
}) {
  return (
    <div className="action-target">
      <div>
        <span className="action-target-kind">{title}</span>
        <strong>{label}</strong>
      </div>
      <div className="action-control">
        <button
          className="button"
          disabled={disabled || actionIsActive(action)}
          onClick={onAction}
          type="button"
        >
          {actionIsActive(action) ? actionStatusLabel(action?.status ?? 'PENDING') : actionLabel}
        </button>
        {action ? <ActionResult action={action} resultLabel={resultLabel} /> : null}
      </div>
    </div>
  );
}

function ActionResult({
  action,
  resultLabel,
}: {
  action: MachineActionRecord;
  resultLabel?: string;
}) {
  return (
    <div className={`action-result action-result-${action.status.toLowerCase()}`} role="status">
      <span>{actionStatusLabel(action.status)}</span>
      {resultLabel ? <strong>{resultLabel}</strong> : null}
      {action.error ? <small>{action.error.message}</small> : null}
    </div>
  );
}

async function submitMachineAction(
  machineId: string,
  input: MachineActionInput,
  setActions: Dispatch<SetStateAction<Record<string, MachineActionRecord>>>,
): Promise<void> {
  const key = `${input.kind}:${input.targetId}`;
  try {
    const response = await fetch(
      `${apiBaseUrl}/machines/${encodeURIComponent(machineId)}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) throw new Error('The Hub could not dispatch this action.');
    const action = (await response.json()) as MachineActionRecord;
    setActions((previous) => ({ ...previous, [key]: action }));
    await watchMachineAction(action.actionId, key, setActions);
  } catch (error) {
    const fallback: MachineActionRecord = {
      actionId: crypto.randomUUID(),
      machineId,
      kind: input.kind,
      targetId: input.targetId,
      status: 'FAILED',
      policyRevision: 'sha256:' + '0'.repeat(64),
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: {
        code: 'process_start_failed',
        message: error instanceof Error ? error.message : 'Action dispatch failed',
      },
    };
    setActions((previous) => ({ ...previous, [key]: fallback }));
  }
}

async function watchMachineAction(
  actionId: string,
  key: string,
  setActions: Dispatch<SetStateAction<Record<string, MachineActionRecord>>>,
): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    try {
      const response = await fetch(`${apiBaseUrl}/actions/${encodeURIComponent(actionId)}`);
      if (!response.ok) continue;
      const action = (await response.json()) as MachineActionRecord;
      setActions((previous) => ({ ...previous, [key]: action }));
      if (['SUCCEEDED', 'DENIED', 'FAILED', 'TIMED_OUT', 'INTERRUPTED'].includes(action.status))
        return;
    } catch {
      // Keep polling; transient API/network loss must not become a false failure.
    }
  }
}

function actionIsActive(action: MachineActionRecord | undefined): boolean {
  return action?.status === 'PENDING' || action?.status === 'RUNNING';
}

function actionStatusLabel(status: MachineActionRecord['status']): string {
  return status === 'TIMED_OUT' ? 'Timed out' : status[0] + status.slice(1).toLowerCase();
}

function repoStatusLabel(action: MachineActionRecord | undefined): string | undefined {
  const result = action?.result;
  if (!result || result.kind !== 'repo.status') return undefined;
  return `${result.branch ?? (result.detached ? 'detached HEAD' : 'unknown branch')} · ${result.dirty ? `${result.staged + result.unstaged + result.untracked} changes` : 'clean'}${result.ahead ? ` · ahead ${result.ahead}` : ''}`;
}

function serviceStatusLabel(action: MachineActionRecord): string | undefined {
  const result = action.result;
  return result?.kind === 'service.restart' ? (result.active ? 'active' : 'inactive') : undefined;
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

type MachinesState =
  | { status: 'loading' }
  | { status: 'error'; message: string; data?: undefined }
  | { status: 'success'; data: MachinesResponse; refreshing: boolean; refreshError?: string };

function useMachines(): MachinesState {
  const [state, setState] = useState<MachinesState>({ status: 'loading' });
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let previousData: MachinesResponse | undefined;
    const load = async () => {
      if (stopped) return;
      controller?.abort();
      controller = new AbortController();
      if (previousData) setState({ status: 'success', data: previousData, refreshing: true });
      try {
        const response = await fetch(`${apiBaseUrl}/machines`, { signal: controller.signal });
        if (!response.ok) throw new Error('The Hub API did not return machine data.');
        const data = (await response.json()) as MachinesResponse;
        previousData = data;
        if (!stopped) setState({ status: 'success', data, refreshing: false });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!stopped && previousData) {
          setState({
            status: 'success',
            data: previousData,
            refreshing: false,
            refreshError: error instanceof Error ? error.message : 'Request failed',
          });
        } else if (!stopped) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Request failed',
          });
        }
      } finally {
        if (!stopped) timer = window.setTimeout(() => void load(), 5_000);
      }
    };
    void load();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
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

function formatBytes(value: number): string {
  const gigabytes = value / 1_000_000_000;
  return `${gigabytes >= 10 ? gigabytes.toFixed(1) : gigabytes.toFixed(2)} GB`;
}

function formatPercentValue(value: number | undefined): string {
  return value === undefined ? 'Unavailable' : `${value.toFixed(0)}%`;
}

function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined) return 'Unavailable';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function formatMachineAge(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}
