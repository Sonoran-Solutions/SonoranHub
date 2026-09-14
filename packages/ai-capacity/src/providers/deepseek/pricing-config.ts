import { z } from 'zod';

export const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';

export interface DeepSeekPeakWindow {
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
}

export interface DeepSeekPricingConfig {
  readonly version: number;
  readonly provider: 'deepseek';
  readonly verifiedAt: string;
  readonly source: string;
  readonly timezone: 'UTC';
  readonly peakWindows: readonly DeepSeekPeakWindow[];
  readonly offPeakMultiplier: number;
}

export const deepSeekPricingConfig: DeepSeekPricingConfig = {
  version: 1,
  provider: 'deepseek',
  verifiedAt: '2026-09-14',
  source: DEEPSEEK_PRICING_SOURCE,
  timezone: 'UTC',
  peakWindows: [
    { weekdays: [1, 2, 3, 4, 5], start: '01:00', end: '04:00' },
    { weekdays: [1, 2, 3, 4, 5], start: '06:00', end: '10:00' },
  ],
  offPeakMultiplier: 0.5,
};

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const deepSeekPricingConfigSchema = z
  .object({
    version: z.number().int().positive(),
    provider: z.literal('deepseek'),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().min(1),
    timezone: z.literal('UTC'),
    peakWindows: z
      .array(
        z.object({
          weekdays: z.array(z.number().int().min(0).max(6)).min(1),
          start: timeSchema,
          end: timeSchema,
        }),
      )
      .min(1),
    offPeakMultiplier: z.number().finite().positive().max(1),
  })
  .passthrough();

export interface CompiledDeepSeekPeakWindow {
  readonly weekdays: ReadonlySet<number>;
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface CompiledDeepSeekPricingConfig {
  readonly config: DeepSeekPricingConfig;
  readonly peakWindows: readonly CompiledDeepSeekPeakWindow[];
}

function minutesFromTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error('Invalid DeepSeek pricing time');
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function verifiedDateIsValid(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function compileDeepSeekPricingConfig(input: unknown): CompiledDeepSeekPricingConfig {
  const parsed = deepSeekPricingConfigSchema.safeParse(input);
  if (!parsed.success || !verifiedDateIsValid(parsed.data.verifiedAt)) {
    throw new Error('Invalid DeepSeek pricing configuration');
  }

  const windows = parsed.data.peakWindows.map((window) => {
    const startMinutes = minutesFromTime(window.start);
    const endMinutes = minutesFromTime(window.end);
    if (startMinutes >= endMinutes || new Set(window.weekdays).size !== window.weekdays.length) {
      throw new Error('Invalid DeepSeek pricing window');
    }
    return {
      weekdays: new Set(window.weekdays),
      startMinutes,
      endMinutes,
    };
  });

  for (const weekday of new Set(windows.flatMap((window) => [...window.weekdays]))) {
    const sameDay = windows
      .filter((window) => window.weekdays.has(weekday))
      .sort((left, right) => left.startMinutes - right.startMinutes);
    for (let index = 1; index < sameDay.length; index += 1) {
      if (sameDay[index]!.startMinutes < sameDay[index - 1]!.endMinutes) {
        throw new Error('Overlapping DeepSeek pricing windows are not supported');
      }
    }
  }

  return { config: parsed.data, peakWindows: windows };
}
