import type { CompiledDeepSeekPricingConfig, DeepSeekPricingConfig } from './pricing-config.js';
import { compileDeepSeekPricingConfig, deepSeekPricingConfig } from './pricing-config.js';

export type DeepSeekPriceState = 'PEAK' | 'OFF_PEAK';

export interface DeepSeekPricingWindowState {
  readonly state: DeepSeekPriceState;
  readonly nextState: DeepSeekPriceState;
  readonly changesAt: string;
  readonly priceMultiplier: number;
  readonly timezone: 'UTC';
  readonly verifiedAt: string;
  readonly source: string;
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid instant for DeepSeek pricing evaluation');
  }
  return date;
}

function utcMinutesOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function isPeakAt(date: Date, schedule: CompiledDeepSeekPricingConfig): boolean {
  const weekday = date.getUTCDay();
  const minutes = utcMinutesOfDay(date);
  return schedule.peakWindows.some(
    (window) =>
      window.weekdays.has(weekday) && minutes >= window.startMinutes && minutes < window.endMinutes,
  );
}

function startOfUtcDay(date: Date, dayOffset: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset),
  );
}

function transitionCandidates(now: Date, schedule: CompiledDeepSeekPricingConfig): Date[] {
  const candidates: Date[] = [];
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const day = startOfUtcDay(now, dayOffset);
    const weekday = day.getUTCDay();
    for (const window of schedule.peakWindows) {
      if (!window.weekdays.has(weekday)) {
        continue;
      }
      candidates.push(new Date(day.getTime() + window.startMinutes * 60_000));
      candidates.push(new Date(day.getTime() + window.endMinutes * 60_000));
    }
  }
  return candidates
    .filter((candidate) => candidate.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime());
}

export function evaluateDeepSeekPricingWindow(
  value: Date | string,
  config: DeepSeekPricingConfig = deepSeekPricingConfig,
): DeepSeekPricingWindowState {
  const now = toDate(value);
  const compiled = compileDeepSeekPricingConfig(config);
  const state: DeepSeekPriceState = isPeakAt(now, compiled) ? 'PEAK' : 'OFF_PEAK';
  const nextTransition = transitionCandidates(now, compiled).find((candidate) => {
    const before = new Date(candidate.getTime() - 1);
    const after = new Date(candidate.getTime() + 1);
    return isPeakAt(before, compiled) !== isPeakAt(after, compiled);
  });

  if (!nextTransition) {
    throw new Error('DeepSeek pricing configuration has no reachable transition');
  }

  const nextState: DeepSeekPriceState = isPeakAt(new Date(nextTransition.getTime() + 1), compiled)
    ? 'PEAK'
    : 'OFF_PEAK';

  return {
    state,
    nextState,
    changesAt: nextTransition.toISOString(),
    priceMultiplier: state === 'PEAK' ? 1 : compiled.config.offPeakMultiplier,
    timezone: 'UTC',
    verifiedAt: compiled.config.verifiedAt,
    source: compiled.config.source,
  };
}
