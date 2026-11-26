import { describe, expect, it } from 'vitest';
import { createProviderTestGate, type ProviderTestDraft } from '../../../src/ai';

const secret = new Uint8Array(32).fill(7);
const scope = JSON.stringify(['camera-vision', 'instance-a', 'owner', 4]);
const draft: ProviderTestDraft = {
  provider: 'camera-ai',
  transport: 'api',
  destination: 'https://api.example.test/v1',
  model: 'vision-model',
  credentials: { apiKey: 'test-key', account: 'camera' },
};

describe('provider model test receipts', () => {
  it('binds the exact resolved draft, actor, purpose, revision, expiry and server key', async () => {
    let now = 100;
    const gate = createProviderTestGate({ secret, ttlMs: 20, now: () => now });
    const receipt = await gate.test(scope, draft, async (tested) => tested.model === 'vision-model');
    expect(receipt).toBeTruthy();
    if (!receipt) throw new Error('Test did not produce a receipt');
    expect(receipt).not.toContain('test-key');
    expect(receipt).not.toContain('vision-model');
    expect(
      gate.accepts(scope, { ...draft, credentials: { account: 'camera', apiKey: 'test-key' } }, receipt),
    ).toBe(true);
    expect(gate.accepts(scope, draft, '119.' + receipt.split('.')[1])).toBe(false);
    expect(
      createProviderTestGate({ secret: new Uint8Array(32), now: () => now }).accepts(scope, draft, receipt),
    ).toBe(false);
    for (const change of [
      { provider: 'another' },
      { transport: 'cli' as const },
      { destination: 'https://different.example.test' },
      { model: 'text-model' },
      { credentials: { ...draft.credentials, apiKey: 'rotated' } },
    ])
      expect(gate.accepts(scope, { ...draft, ...change }, receipt)).toBe(false);
    for (const otherScope of [
      ['camera-vision', 'instance-b', 'owner', 4],
      ['camera-vision', 'instance-a', 'other-owner', 4],
      ['camera-vision', 'instance-a', 'owner', 5],
      ['text-only', 'instance-a', 'owner', 4],
    ])
      expect(gate.accepts(JSON.stringify(otherScope), draft, receipt)).toBe(false);
    now = 120;
    expect(gate.accepts(scope, draft, receipt)).toBe(false);
  });

  it('does not issue receipts for false, failed or cancelled probes', async () => {
    const gate = createProviderTestGate({ secret });
    expect(await gate.test(scope, draft, async () => false)).toBeNull();
    expect(
      await gate.test(scope, draft, async () => {
        throw new Error('test-key');
      }),
    ).toBeNull();
    const controller = new AbortController();
    const pending = gate.test(scope, draft, async () => new Promise(() => {}), controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
  });
});
