import { z } from 'zod';

import type { CapacityResource } from '@sonoran-hub/contracts';

import type { ProviderFailureCode } from '../../errors.js';

const decimalString = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'must be a non-negative decimal string');

const deepSeekBalanceInfoSchema = z
  .object({
    currency: z.enum(['USD', 'CNY']),
    total_balance: decimalString,
    granted_balance: decimalString,
    topped_up_balance: decimalString,
  })
  .passthrough();

export const deepSeekBalanceResponseSchema = z
  .object({
    is_available: z.boolean(),
    balance_infos: z.array(deepSeekBalanceInfoSchema),
  })
  .passthrough();

export type DeepSeekBalanceResponse = z.infer<typeof deepSeekBalanceResponseSchema>;

export interface NormalizedDeepSeekBalanceInfo {
  readonly currency: 'USD' | 'CNY';
  readonly totalBalance: number;
  readonly grantedBalance: number;
  readonly toppedUpBalance: number;
}

export interface DeepSeekBalanceNormalization {
  readonly usdResource: CapacityResource;
  readonly otherBalances: readonly NormalizedDeepSeekBalanceInfo[];
}

export interface DeepSeekBalanceFailure {
  readonly code: ProviderFailureCode;
  readonly message: string;
}

export class DeepSeekBalanceDataError extends Error {
  constructor(message = 'DeepSeek returned invalid balance data') {
    super(message);
    this.name = 'DeepSeekBalanceDataError';
  }
}

function roundMoney(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000_000) / 1_000_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function parseDeepSeekDecimal(value: string): number {
  if (!decimalString.safeParse(value).success) {
    throw new DeepSeekBalanceDataError('DeepSeek returned an invalid monetary value');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new DeepSeekBalanceDataError('DeepSeek returned an invalid monetary value');
  }
  return roundMoney(parsed);
}

function normalizedBalanceInfo(
  info: z.infer<typeof deepSeekBalanceInfoSchema>,
): NormalizedDeepSeekBalanceInfo {
  return {
    currency: info.currency,
    totalBalance: parseDeepSeekDecimal(info.total_balance),
    grantedBalance: parseDeepSeekDecimal(info.granted_balance),
    toppedUpBalance: parseDeepSeekDecimal(info.topped_up_balance),
  };
}

function balanceMetadata(
  isAvailable: boolean,
  usd: NormalizedDeepSeekBalanceInfo | undefined,
  otherBalances: readonly NormalizedDeepSeekBalanceInfo[],
): Record<string, unknown> {
  return {
    is_available: isAvailable,
    ...(usd
      ? {
          currency: usd.currency,
          granted_balance: usd.grantedBalance,
          topped_up_balance: usd.toppedUpBalance,
        }
      : {}),
    ...(otherBalances.length > 0
      ? {
          additional_balances: otherBalances.map((balance) => ({
            currency: balance.currency,
            total_balance: balance.totalBalance,
            granted_balance: balance.grantedBalance,
            topped_up_balance: balance.toppedUpBalance,
          })),
        }
      : {}),
  };
}

export function normalizeDeepSeekBalance(
  response: DeepSeekBalanceResponse,
  collectedAt: string,
): DeepSeekBalanceNormalization {
  const balances = response.balance_infos.map(normalizedBalanceInfo);
  const usdBalances = balances.filter((balance) => balance.currency === 'USD');
  if (usdBalances.length > 1) {
    throw new DeepSeekBalanceDataError('DeepSeek returned duplicate USD balance entries');
  }
  const usd = usdBalances[0];
  const otherBalances = balances.filter((balance) => balance.currency !== 'USD');
  const metadata = balanceMetadata(response.is_available, usd, otherBalances);

  if (!usd) {
    return {
      usdResource: {
        id: 'deepseek-wallet-usd',
        provider: 'deepseek',
        kind: 'wallet',
        name: 'DeepSeek balance',
        unit: 'usd',
        status: 'unknown',
        source: 'official_api',
        collectedAt,
        freshness: 'fresh',
        error: {
          code: 'unavailable',
          message: 'DeepSeek did not return a USD balance entry',
        },
        metadata,
      },
      otherBalances,
    };
  }

  const status =
    usd.totalBalance === 0 ? 'exhausted' : response.is_available ? 'available' : 'unknown';
  return {
    usdResource: {
      id: 'deepseek-wallet-usd',
      provider: 'deepseek',
      kind: 'wallet',
      name: 'DeepSeek balance',
      remaining: usd.totalBalance,
      unit: 'usd',
      status,
      source: 'official_api',
      collectedAt,
      freshness: 'fresh',
      metadata: {
        ...metadata,
        ...(response.is_available || usd.totalBalance === 0
          ? {}
          : {
              availability_discrepancy:
                'DeepSeek reported the account unavailable despite a positive USD balance',
            }),
      },
    },
    otherBalances,
  };
}
