import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyGitHubWebhookSignature } from './webhookSignature.js';

describe('verifyGitHubWebhookSignature', () => {
  const secret = 'super-secret-webhook-key-12345';
  const bodyText = '{"action":"opened","repository":{"full_name":"Sonoran-Solutions/SonoranHub"}}';
  const bodyBuffer = Buffer.from(bodyText, 'utf8');

  function computeValidSignature(sec: string, buf: Buffer): string {
    return `sha256=${createHmac('sha256', sec).update(buf).digest('hex')}`;
  }

  it('accepts valid raw bytes with correct secret and signature', () => {
    const signature = computeValidSignature(secret, bodyBuffer);
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, signature)).toBe(true);
  });

  it('rejects wrong secret', () => {
    const signature = computeValidSignature('wrong-secret', bodyBuffer);
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, signature)).toBe(false);
  });

  it('rejects modified body with old signature', () => {
    const signature = computeValidSignature(secret, bodyBuffer);
    const tamperedBuffer = Buffer.from(
      '{"action":"closed","repository":{"full_name":"Sonoran-Solutions/SonoranHub"}}',
      'utf8',
    );
    expect(verifyGitHubWebhookSignature(secret, tamperedBuffer, signature)).toBe(false);
  });

  it('rejects missing signature header', () => {
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, undefined)).toBe(false);
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, '')).toBe(false);
  });

  it('rejects malformed signature header prefix', () => {
    const rawSig = createHmac('sha256', secret).update(bodyBuffer).digest('hex');
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, rawSig)).toBe(false);
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, `sha1=${rawSig}`)).toBe(false);
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, `sha512=${rawSig}`)).toBe(false);
  });

  it('rejects invalid hex characters in signature', () => {
    const invalidHex = `sha256=${'z'.repeat(64)}`;
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, invalidHex)).toBe(false);
  });

  it('rejects different-length digests safely', () => {
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, 'sha256=abcd')).toBe(false);
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, `sha256=${'0'.repeat(32)}`)).toBe(
      false,
    );
    expect(verifyGitHubWebhookSignature(secret, bodyBuffer, `sha256=${'0'.repeat(128)}`)).toBe(
      false,
    );
  });

  it('rejects body when whitespace changes (proving raw byte verification)', () => {
    const signature = computeValidSignature(secret, bodyBuffer);
    const whitespaceBuffer = Buffer.from(bodyText + ' ', 'utf8');
    expect(verifyGitHubWebhookSignature(secret, whitespaceBuffer, signature)).toBe(false);

    const indentedBuffer = Buffer.from(JSON.stringify(JSON.parse(bodyText), null, 2), 'utf8');
    expect(verifyGitHubWebhookSignature(secret, indentedBuffer, signature)).toBe(false);
  });

  it('rejects valid JSON when keys are reordered/reformatted', () => {
    const signature = computeValidSignature(secret, bodyBuffer);
    // Reordered keys in JSON
    const reorderedJson =
      '{"repository":{"full_name":"Sonoran-Solutions/SonoranHub"},"action":"opened"}';
    const reorderedBuffer = Buffer.from(reorderedJson, 'utf8');
    expect(verifyGitHubWebhookSignature(secret, reorderedBuffer, signature)).toBe(false);
  });

  it('rejects empty secret', () => {
    const signature = computeValidSignature(secret, bodyBuffer);
    expect(verifyGitHubWebhookSignature('', bodyBuffer, signature)).toBe(false);
  });
});
