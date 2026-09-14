import { describe, expect, it } from 'vitest';

import {
  normalizeDeepSeekBalance,
  parseDeepSeekDecimal,
  type DeepSeekBalanceResponse,
} from './balance.js';

const collectedAt = '2026-09-14T12:00:00.000Z';

function balanceResponse(
  overrides: Partial<DeepSeekBalanceResponse> = {},
): DeepSeekBalanceResponse {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'USD',
        total_balance: '14.82',
        granted_balance: '4.82',
        topped_up_balance: '10.00',
      },
    ],
    ...overrides,
  };
}

describe('DeepSeek decimal parsing', () => {
  it.each(['0', '0.00', '14.82', '100.5000'])('accepts %s', (value) => {
    expect(parseDeepSeekDecimal(value)).toBe(Number(value));
  });

  it.each(['', 'NaN', 'Infinity', '$14.82', '14 dollars', '-1', '1e3', ' 14.82'])(
    'rejects %s',
    (value) => {
      expect(() => parseDeepSeekDecimal(value)).toThrow('invalid monetary value');
    },
  );
});

describe('DeepSeek balance normalization', () => {
  it('normalizes USD available balance without inventing a limit or reset', () => {
    const result = normalizeDeepSeekBalance(balanceResponse(), collectedAt);

    expect(result.usdResource).toMatchObject({
      id: 'deepseek-wallet-usd',
      provider: 'deepseek',
      kind: 'wallet',
      name: 'DeepSeek balance',
      remaining: 14.82,
      unit: 'usd',
      status: 'available',
      source: 'official_api',
      collectedAt,
      freshness: 'fresh',
      metadata: {
        is_available: true,
        currency: 'USD',
        granted_balance: 4.82,
        topped_up_balance: 10,
      },
    });
    expect(result.usdResource).not.toHaveProperty('limit');
    expect(result.usdResource).not.toHaveProperty('used');
    expect(result.usdResource).not.toHaveProperty('remainingPercent');
    expect(result.usdResource).not.toHaveProperty('resetAt');
  });

  it('marks zero balance exhausted', () => {
    const result = normalizeDeepSeekBalance(
      balanceResponse({
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '0.00',
            granted_balance: '0',
            topped_up_balance: '0',
          },
        ],
      }),
      collectedAt,
    );

    expect(result.usdResource).toMatchObject({ remaining: 0, status: 'exhausted' });
  });

  it('preserves CNY separately instead of treating it as USD', () => {
    const result = normalizeDeepSeekBalance(
      balanceResponse({
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '14.82',
            granted_balance: '4.82',
            topped_up_balance: '10.00',
          },
          {
            currency: 'CNY',
            total_balance: '100.50',
            granted_balance: '20.50',
            topped_up_balance: '80.00',
          },
        ],
      }),
      collectedAt,
    );

    expect(result.usdResource).toMatchObject({ remaining: 14.82, unit: 'usd' });
    expect(result.otherBalances).toEqual([
      {
        currency: 'CNY',
        totalBalance: 100.5,
        grantedBalance: 20.5,
        toppedUpBalance: 80,
      },
    ]);
    expect(result.usdResource.metadata).toMatchObject({
      additional_balances: [
        { currency: 'CNY', total_balance: 100.5, granted_balance: 20.5, topped_up_balance: 80 },
      ],
    });
  });

  it('represents CNY-only responses as an unknown USD wallet', () => {
    const result = normalizeDeepSeekBalance(
      balanceResponse({
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '100.50',
            granted_balance: '20.50',
            topped_up_balance: '80.00',
          },
        ],
      }),
      collectedAt,
    );

    expect(result.usdResource).toMatchObject({
      status: 'unknown',
      freshness: 'fresh',
      error: { code: 'unavailable' },
      metadata: { is_available: true },
    });
    expect(result.usdResource).not.toHaveProperty('remaining');
  });

  it('does not claim a positive balance is usable when the provider says unavailable', () => {
    const result = normalizeDeepSeekBalance(balanceResponse({ is_available: false }), collectedAt);

    expect(result.usdResource).toMatchObject({
      remaining: 14.82,
      status: 'unknown',
      metadata: { availability_discrepancy: expect.any(String) },
    });
  });
});
