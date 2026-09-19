import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validates a GitHub webhook signature using timing-safe HMAC-SHA256 verification.
 * Operates on the exact raw request bytes.
 *
 * Rejects missing, malformed, invalid hex, mismatched length, or incorrect signatures.
 * Never throws and never logs or exposes secrets or raw payloads.
 */
export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  // GitHub sends: "sha256=<64 hex characters>"
  if (!signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const signatureHex = signatureHeader.slice('sha256='.length);
  // SHA-256 hex digest is exactly 64 characters (32 bytes)
  if (signatureHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(signatureHex)) {
    return false;
  }

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  const expectedBuffer = Buffer.from(expectedHex, 'hex');
  const signatureBuffer = Buffer.from(signatureHex, 'hex');

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
