import type { CapacityFreshness, CapacityResource, CapacityStatus } from '@sonoran-hub/contracts';

export function providerLabel(providerId: string): string {
  return providerId === 'openrouter'
    ? 'OpenRouter'
    : providerId === 'deepseek'
      ? 'DeepSeek'
      : providerId;
}

export function formatMoney(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? 'Not reported' : `${value.toFixed(1)}%`;
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'Not available';
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function resourceValue(resource: CapacityResource): string {
  if (resource.metadata?.budget_state === 'unbounded') {
    return 'No spending cap configured';
  }
  if (resource.kind === 'pricing_window') {
    const state =
      typeof resource.metadata?.state === 'string' ? resource.metadata.state : 'Unknown';
    const multiplier =
      typeof resource.metadata?.price_multiplier === 'number'
        ? ` · ${resource.metadata.price_multiplier}× price`
        : '';
    return `${state}${multiplier}`;
  }
  if (resource.unit === 'usd') {
    return formatMoney(resource.remaining);
  }
  if (resource.unit === 'percent') {
    return formatPercent(resource.remainingPercent);
  }
  if (resource.remaining !== undefined) {
    return `${resource.remaining} ${resource.unit}`;
  }
  return 'Not reported';
}

export function resourceDetail(resource: CapacityResource): string | undefined {
  if (resource.unit === 'usd' && resource.remaining !== undefined) {
    const parts = [
      resource.remainingPercent === undefined
        ? undefined
        : `${formatPercent(resource.remainingPercent)} remaining`,
      resource.limit === undefined ? undefined : `of ${formatMoney(resource.limit)}`,
      resource.used === undefined ? undefined : `${formatMoney(resource.used)} used`,
    ].filter((part): part is string => part !== undefined);
    return parts.join(' · ') || undefined;
  }
  if (resource.resetAt) {
    return `Resets ${formatTimestamp(resource.resetAt)}`;
  }
  if (resource.changesAt) {
    return `Changes ${formatTimestamp(resource.changesAt)}`;
  }
  return undefined;
}

export function statusLabel(status: CapacityStatus): string {
  return status.replace('_', ' ');
}

export function freshnessLabel(freshness: CapacityFreshness): string {
  return freshness.replace('_', ' ');
}
