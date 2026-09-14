import { describe, expect, it } from 'vitest';

import {
  compileDeepSeekPricingConfig,
  deepSeekPricingConfig,
  type DeepSeekPricingConfig,
} from './pricing-config.js';
import { evaluateDeepSeekPricingWindow } from './pricing.js';

const mondayAt = (time: string) => `2026-09-14T${time}Z`;

function expectWindow(
  instant: string,
  state: 'PEAK' | 'OFF_PEAK',
  nextState: 'PEAK' | 'OFF_PEAK',
  changesAt: string,
): void {
  expect(evaluateDeepSeekPricingWindow(instant)).toMatchObject({
    state,
    nextState,
    changesAt,
    priceMultiplier: state === 'PEAK' ? 1 : 0.5,
    timezone: 'UTC',
    verifiedAt: '2026-09-14',
  });
}

describe('DeepSeek pricing-window engine', () => {
  it('handles both weekday peak windows and their exact boundaries', () => {
    expectWindow(mondayAt('00:59:59'), 'OFF_PEAK', 'PEAK', '2026-09-14T01:00:00.000Z');
    expectWindow(mondayAt('01:00:00'), 'PEAK', 'OFF_PEAK', '2026-09-14T04:00:00.000Z');
    expectWindow(mondayAt('03:59:59'), 'PEAK', 'OFF_PEAK', '2026-09-14T04:00:00.000Z');
    expectWindow(mondayAt('04:00:00'), 'OFF_PEAK', 'PEAK', '2026-09-14T06:00:00.000Z');
    expectWindow(mondayAt('05:59:59'), 'OFF_PEAK', 'PEAK', '2026-09-14T06:00:00.000Z');
    expectWindow(mondayAt('06:00:00'), 'PEAK', 'OFF_PEAK', '2026-09-14T10:00:00.000Z');
    expectWindow(mondayAt('09:59:59'), 'PEAK', 'OFF_PEAK', '2026-09-14T10:00:00.000Z');
    expectWindow(mondayAt('10:00:00'), 'OFF_PEAK', 'PEAK', '2026-09-15T01:00:00.000Z');
  });

  it('keeps the weekend off-peak and finds the Friday-to-Monday transition', () => {
    expectWindow('2026-09-18T10:00:00Z', 'OFF_PEAK', 'PEAK', '2026-09-21T01:00:00.000Z');
    expectWindow('2026-09-19T12:00:00Z', 'OFF_PEAK', 'PEAK', '2026-09-21T01:00:00.000Z');
    expectWindow('2026-09-20T12:00:00Z', 'OFF_PEAK', 'PEAK', '2026-09-21T01:00:00.000Z');
  });

  it('computes by UTC rather than the machine local timezone', () => {
    expect(evaluateDeepSeekPricingWindow('2026-09-14T01:00:00-07:00')).toMatchObject({
      state: 'PEAK',
      changesAt: '2026-09-14T10:00:00.000Z',
    });
  });

  it.each([
    ['missing windows', { ...deepSeekPricingConfig, peakWindows: [] }],
    [
      'bad time',
      {
        ...deepSeekPricingConfig,
        peakWindows: [{ weekdays: [1], start: '25:00', end: '04:00' }],
      },
    ],
    [
      'reversed time',
      {
        ...deepSeekPricingConfig,
        peakWindows: [{ weekdays: [1], start: '04:00', end: '01:00' }],
      },
    ],
    [
      'overlapping windows',
      {
        ...deepSeekPricingConfig,
        peakWindows: [
          { weekdays: [1], start: '01:00', end: '04:00' },
          { weekdays: [1], start: '03:00', end: '05:00' },
        ],
      },
    ],
    ['wrong timezone', { ...deepSeekPricingConfig, timezone: 'America/Phoenix' }],
    ['bad verification date', { ...deepSeekPricingConfig, verifiedAt: '2026-02-30' }],
    ['bad multiplier', { ...deepSeekPricingConfig, offPeakMultiplier: 1.5 }],
  ] as [string, unknown][])('rejects invalid configuration: %s', (_name, config) => {
    expect(() => compileDeepSeekPricingConfig(config)).toThrow();
  });

  it('accepts a separately supplied versioned configuration', () => {
    const config: DeepSeekPricingConfig = {
      ...deepSeekPricingConfig,
      version: 2,
      offPeakMultiplier: 0.25,
    };

    expect(evaluateDeepSeekPricingWindow(mondayAt('02:00:00'), config)).toMatchObject({
      state: 'PEAK',
      priceMultiplier: 1,
      verifiedAt: config.verifiedAt,
    });
    expect(evaluateDeepSeekPricingWindow(mondayAt('05:00:00'), config)).toMatchObject({
      state: 'OFF_PEAK',
      priceMultiplier: 0.25,
    });
  });
});
