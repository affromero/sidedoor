import { createHmac, timingSafeEqual } from 'node:crypto';
import { abortable } from '../../runtime/process/abort';
import type { CredentialValues } from '../index';
import type { ProviderDescriptor } from '../browser';

export interface ProviderTestDraft {
  readonly provider: string;
  readonly transport: ProviderDescriptor['transport'];
  /** Canonical, application-approved endpoint or CLI login identity. */
  readonly destination: string;
  readonly model: string;
  /** Effective credentials after applying the patch to the current stored values. */
  readonly credentials: Readonly<CredentialValues>;
}

export interface ProviderTestOptions {
  /** Server-only secret shared by instances that accept the same receipts. */
  secret: Uint8Array;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

function snapshot(draft: ProviderTestDraft): ProviderTestDraft | null {
  const { provider, transport, destination, model, credentials } = draft;
  if (![provider, destination, model].every((field) => typeof field === 'string' && field.trim()))
    return null;
  if (!['api', 'local', 'cli', 'ssh'].includes(transport)) return null;
  const values = { ...credentials };
  if (
    !Object.values(values).every(
      (value) => typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value),
    )
  )
    return null;
  return Object.freeze({ provider, transport, destination, model, credentials: Object.freeze(values) });
}

export function createProviderTestGate({
  secret,
  ttlMs = 5 * 60_000,
  timeoutMs = 20_000,
  now = Date.now,
}: ProviderTestOptions) {
  if (secret.byteLength < 32) throw new Error('Provider test secret must contain at least 32 bytes');
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    throw new Error('Invalid provider test timeout');
  const key = Buffer.from(secret);
  const sign = (scope: string, draft: ProviderTestDraft, expires: number) =>
    createHmac('sha256', key)
      .update(
        JSON.stringify([
          'sidedoor-provider-test-v1',
          scope,
          expires,
          draft.provider,
          draft.transport,
          draft.destination,
          draft.model,
          Object.keys(draft.credentials)
            .sort()
            .map((name) => [name, draft.credentials[name]]),
        ]),
      )
      .digest();

  return {
    async test(
      scope: string,
      draft: ProviderTestDraft,
      probe: (draft: ProviderTestDraft, signal: AbortSignal) => Promise<boolean>,
      signal?: AbortSignal,
    ): Promise<string | null> {
      const selected = snapshot(draft);
      if (!scope || !selected) return null;
      const deadline = AbortSignal.timeout(timeoutMs);
      const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        operation.throwIfAborted();
        const passed = await abortable(probe(selected, operation), operation);
        if (passed !== true || operation.aborted) return null;
        const expires = now() + ttlMs;
        return expires + '.' + sign(scope, selected, expires).toString('base64url');
      } catch {
        return null;
      }
    },

    /** Re-resolve and check the effective draft inside the application's write transaction. */
    accepts(scope: string, draft: ProviderTestDraft, receipt: string): boolean {
      if (!scope || typeof receipt !== 'string' || receipt.length > 60) return false;
      const match = /^(\d{1,16})\.([\w-]{43})$/.exec(receipt);
      if (!match?.[2]) return false;
      const expires = Number(match[1]);
      if (!Number.isSafeInteger(expires) || expires <= now()) return false;
      const selected = snapshot(draft);
      if (!selected) return false;
      const supplied = Buffer.from(match[2], 'base64url');
      return (
        supplied.toString('base64url') === match[2] &&
        timingSafeEqual(supplied, sign(scope, selected, expires))
      );
    },
  };
}
