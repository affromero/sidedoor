import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderAvailability, ProviderCreditsExhaustedError } from '../../src/providers/availability';
import { sqlStateBackend } from '../../src/storage/sql/sql';

const databases: DatabaseSync[] = [];
const exhausted = { status: 402, body: 'Model credits limit reached: Please upgrade your subscription.' };
const selection = { provider: 'cartesia', origin: 'https://api.cartesia.ai', credential: 'test-secret-key' };
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(
    'CREATE TABLE "SidedoorState" ("id" TEXT PRIMARY KEY, "revision" TEXT NOT NULL, "state" TEXT NOT NULL)',
  );
  const database = {
    async query(sql: string, values: readonly unknown[]) {
      return db.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  const create = (instanceId = 'instance', namespace = 'application') =>
    new ProviderAvailability({
      namespace,
      instanceId,
      backend: (id) => sqlStateBackend(database, 'sqlite', id),
    });
  return { db, create, availability: create() };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('provider account availability', () => {
  it('persists a confirmed exhausted account across registries without storing its credential or response', async () => {
    const { availability, create, db } = fixture();
    const account = availability.captureAccount(selection);
    expect(await availability.status(account)).toEqual({ state: 'unobserved', checkedAt: null });
    expect(await availability.observeFailure(account, exhausted)).toBe(true);
    const restored = create();
    const restoredAccount = restored.captureAccount(selection);
    await expect(restored.assertAvailable(restoredAccount)).rejects.toBeInstanceOf(
      ProviderCreditsExhaustedError,
    );
    expect(await restored.status(restoredAccount)).toEqual({
      state: 'credits_exhausted',
      checkedAt: expect.any(Number),
    });
    const stored = JSON.stringify(db.prepare('SELECT * FROM SidedoorState').all());
    expect(stored).not.toContain(selection.credential);
    expect(stored).not.toContain(exhausted.body);
    expect(account).not.toHaveProperty('credential');
  });

  it('shares an actual account across modalities and isolates credentials, providers, origins, namespaces and instances', async () => {
    const { availability, create } = fixture();
    const tts = availability.captureAccount(selection);
    const stt = availability.captureAccount(selection);
    expect(stt).toEqual(tts);
    await availability.observeFailure(tts, exhausted);
    await expect(availability.assertAvailable(stt)).rejects.toMatchObject({
      code: 'PROVIDER_CREDITS_EXHAUSTED',
    });
    for (const alternate of [
      { ...selection, credential: 'different-key' },
      { ...selection, provider: 'openai' },
      { ...selection, origin: 'https://private.example' },
    ])
      expect(await availability.status(availability.captureAccount(alternate))).toEqual({
        state: 'unobserved',
        checkedAt: null,
      });
    for (const other of [create('other-instance'), create('instance', 'other-application')])
      expect(await other.status(other.captureAccount(selection))).toEqual({
        state: 'unobserved',
        checkedAt: null,
      });
  });

  it('rejects forged or foreign account handles and credential-bearing or noncanonical origins', async () => {
    const { availability, create } = fixture();
    const account = availability.captureAccount(selection);
    await expect(availability.status({ ...account })).rejects.toThrow('another registry');
    await expect(create().status(account)).rejects.toThrow('another registry');
    for (const origin of [
      'https://key@api.cartesia.ai',
      'https://api.cartesia.ai/v1',
      'https://api.cartesia.ai?secret=key',
      'https://api.cartesia.ai#fragment',
      'file:///',
    ])
      expect(() => availability.captureAccount({ ...selection, origin })).toThrow();
    expect(
      availability.captureAccount({ ...selection, origin: 'https://API.CARTESIA.AI:443/' }).identity,
    ).toBe(account.identity);
  });

  it.each([
    ['openai', 'https://api.openai.com', 429, { error: { code: 'insufficient_quota' } }],
    ['openai', 'https://api.openai.com', 429, { error: { code: 'credit_balance_exhausted' } }],
    ['elevenlabs', 'https://api.elevenlabs.io', 401, { detail: { status: 'quota_exceeded' } }],
    ['elevenlabs', 'https://api.elevenlabs.io', 402, { detail: { code: 'insufficient_credits' } }],
    ['cartesia', 'https://api.cartesia.ai', 402, exhausted.body],
  ])('blocks %s only after its documented credit signal (%s/%s)', async (provider, origin, status, body) => {
    const { availability } = fixture();
    const account = availability.captureAccount({ provider, origin, credential: 'key' });
    expect(await availability.observeFailure(account, { status, body })).toBe(true);
    await expect(availability.assertAvailable(account)).rejects.toMatchObject({
      provider,
      code: 'PROVIDER_CREDITS_EXHAUSTED',
    });
  });

  it.each([
    ['cartesia', 'https://api.cartesia.ai', 402, 'Payment required'],
    ['cartesia', 'https://api.cartesia.ai', 402, 'Error: Model credits limit reached:'],
    ['cartesia', 'https://api.cartesia.ai', 429, exhausted.body],
    ['cartesia', 'https://private.example', 402, exhausted.body],
    [
      'openai',
      'https://api.openai.com',
      429,
      { error: { code: 'rate_limit_exceeded', type: 'insufficient_quota' } },
    ],
    ['openai', 'https://api.openai.com', 401, { error: { code: 'insufficient_quota' } }],
    ['elevenlabs', 'https://api.elevenlabs.io', 401, { detail: { status: 'invalid_api_key' } }],
    ['elevenlabs', 'https://api.elevenlabs.io', 429, { detail: { status: 'quota_exceeded' } }],
    ['hume', 'https://api.hume.ai', 402, exhausted.body],
    ['cartesia', 'https://api.cartesia.ai', 500, null],
  ])('keeps an unrecognized %s response unknown (%s/%s)', async (provider, origin, status, body) => {
    const { availability, db } = fixture();
    const account = availability.captureAccount({ provider, origin, credential: 'key' });
    expect(await availability.observeFailure(account, { status, body })).toBe(false);
    expect(await availability.status(account)).toEqual({ state: 'unobserved', checkedAt: null });
    expect(db.prepare('SELECT * FROM SidedoorState').all()).toEqual([]);
  });

  it('never clears an exhausted account on unrelated successful or failed responses', async () => {
    const { availability } = fixture();
    const account = availability.captureAccount(selection);
    await availability.observeFailure(account, exhausted);
    const previous = await availability.status(account);
    await availability.observeFailure(account, { status: 200, body: { limitReached: false } });
    await availability.observeFailure(account, { status: 500, body: 'Temporary failure' });
    expect(await availability.status(account)).toEqual(previous);
  });

  it('records the timestamp of one explicitly validated operation and returns its actual result', async () => {
    const { availability } = fixture();
    const account = availability.captureAccount(selection);
    await availability.observeFailure(account, exhausted);
    const audio = new Uint8Array([1, 2, 3]);
    const started = Date.now();
    const result = await availability.recheck(
      account,
      async () => audio,
      async (value) => {
        expect(value).toBe(audio);
        if (value.byteLength === 0) throw new Error('Invalid audio');
      },
    );
    expect(result).toBe(audio);
    const status = await availability.status(account);
    expect(status.state).toBe('verified_available');
    expect(status.checkedAt).toBeGreaterThanOrEqual(started);
    await availability.assertAvailable(account);
    await availability.observeFailure(account, exhausted);
    await expect(availability.assertAvailable(account)).rejects.toBeInstanceOf(ProviderCreditsExhaustedError);
  });

  it('keeps exhaustion after transport, validation or cancellation failure', async () => {
    const { availability } = fixture();
    const account = availability.captureAccount(selection);
    await availability.observeFailure(account, exhausted);
    const previous = await availability.status(account);
    await expect(
      availability.recheck(
        account,
        async () => {
          throw new Error('Transport failed');
        },
        async () => {},
      ),
    ).rejects.toThrow('Transport failed');
    await expect(
      availability.recheck(
        account,
        async () => new Uint8Array(),
        async () => {
          throw new Error('Invalid audio');
        },
      ),
    ).rejects.toThrow('Invalid audio');
    const cancellation = new AbortController();
    await expect(
      availability.recheck(
        account,
        async () => {
          cancellation.abort(new Error('Cancelled'));
          return new Uint8Array([1]);
        },
        async () => {},
        cancellation.signal,
      ),
    ).rejects.toThrow('Cancelled');
    expect(await availability.status(account)).toEqual(previous);
  });

  it('preserves a newer exhausted revision even when an older verification succeeds', async () => {
    const { availability, create } = fixture();
    const account = availability.captureAccount(selection);
    await availability.observeFailure(account, exhausted);
    const concurrent = create();
    await expect(
      availability.recheck(
        account,
        async () => {
          await concurrent.observeFailure(concurrent.captureAccount(selection), exhausted);
          return new Uint8Array([1]);
        },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(ProviderCreditsExhaustedError);
    expect((await availability.status(account)).state).toBe('credits_exhausted');
  });

  it('fails closed on corrupt saved state and preserves an original provider error as the cause', async () => {
    const { availability, db } = fixture();
    const account = availability.captureAccount(selection);
    await availability.observeFailure(account, exhausted);
    db.exec("UPDATE SidedoorState SET state = '{}'");
    await expect(availability.assertAvailable(account)).rejects.toThrow();
    const original = new Error('Provider payment response');
    const error = new ProviderCreditsExhaustedError('cartesia', { cause: original });
    expect(error.cause).toBe(original);
    expect(error.message).not.toContain(selection.credential);
  });
});
