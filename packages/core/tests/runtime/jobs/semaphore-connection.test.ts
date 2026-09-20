import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  openSemaphoreSession,
  SemaphoreCleanupError,
  type SemaphoreConnectionPort,
} from '../../../src/runtime/sync/semaphore';

function fixture() {
  const events = new EventEmitter();
  const state = { connected: false, closed: false, held: false, commands: [] as string[] };
  const client: SemaphoreConnectionPort = {
    async connect() {
      state.connected = true;
    },
    async end() {
      state.closed = true;
      events.emit('end');
    },
    onError(listener) {
      events.on('error', listener);
      return () => {
        events.off('error', listener);
      };
    },
    onEnd(listener) {
      events.on('end', listener);
      return () => {
        events.off('end', listener);
      };
    },
    async eval(...input) {
      const operation = input[2][1]!;
      state.commands.push(operation);
      if (operation === 'release') {
        state.held = false;
        return 1;
      }
      state.held = true;
      return Date.now() + 5000;
    },
  };
  const options = {
    namespace: 'test',
    resource: 'tts',
    limit: 1,
    ttlMs: 5000,
    connectMs: 20,
    commandMs: 20,
    closeMs: 20,
  };
  return { client, options, events, state };
}

describe('semaphore connection ownership', () => {
  it('releases its token and closes the session once, with repeat cleanup remaining safe', async () => {
    const { client, options, state, events } = fixture();
    const session = await openSemaphoreSession(client, options);
    expect(await session.acquire()).toBe(true);
    await session.release();
    await session.release();
    expect(state).toMatchObject({ held: false, closed: true, commands: ['acquire', 'release'] });
    expect(events.eventNames()).toEqual([]);
  });

  it('closes a late connection after the opening deadline instead of abandoning it', async () => {
    const { client, options, state } = fixture();
    let finish!: () => void;
    client.connect = () =>
      new Promise<void>((resolve) => {
        finish = () => {
          state.connected = true;
          resolve();
        };
      });
    await expect(openSemaphoreSession(client, options)).rejects.toBeInstanceOf(SemaphoreCleanupError);
    expect(state.closed).toBe(false);
    finish();
    await expect.poll(() => state.closed).toBe(true);
  });

  it('retains token uncertainty after command timeout even when the socket closes', async () => {
    const { client, options, state } = fixture();
    let finish!: () => void;
    client.eval = async () =>
      new Promise<number>((resolve) => {
        state.held = true;
        finish = () => resolve(Date.now() + 5000);
      });
    const session = await openSemaphoreSession(client, options);
    await expect(session.acquire()).rejects.toThrow('outcome is unknown');
    expect(state.closed).toBe(true);
    await expect(session.release()).rejects.toBeInstanceOf(SemaphoreCleanupError);
    expect(state.held).toBe(true);
    finish();
    await expect(session.acquire()).rejects.toThrow();
  });

  it('does not dispatch on a connection lost before acquisition', async () => {
    const { client, options, state, events } = fixture();
    const session = await openSemaphoreSession(client, options);
    events.emit('error', new Error('Connection lost'));
    await expect(session.acquire()).rejects.toThrow();
    await expect(session.release()).rejects.toBeInstanceOf(SemaphoreCleanupError);
    expect(state.commands).toEqual([]);
    expect(state.closed).toBe(true);
  });

  it('keeps closure uncertainty after a confirmed token release', async () => {
    const { client, options, state, events } = fixture();
    client.end = async () => {
      throw new Error('Socket close unconfirmed');
    };
    const session = await openSemaphoreSession(client, options);
    await session.acquire();
    await expect(session.release()).rejects.toBeInstanceOf(SemaphoreCleanupError);
    expect(state.held).toBe(false);
    expect(state.closed).toBe(false);
    expect(events.listenerCount('error')).toBe(1);
  });

  it('validates lease options before opening a connection', async () => {
    const { client, options, state, events } = fixture();
    await expect(openSemaphoreSession(client, { ...options, limit: 0 })).rejects.toThrow();
    expect(state.connected).toBe(false);
    expect(events.eventNames()).toEqual([]);
  });

  it('releases an acquired token and closes when wait options are invalid', async () => {
    const { client, options, state, events } = fixture();
    const session = await openSemaphoreSession(client, options);
    expect(await session.acquire()).toBe(true);
    await expect(session.wait({ delaysMs: [-1] })).rejects.toThrow();
    expect(state).toMatchObject({ held: false, closed: true });
    expect(events.eventNames()).toEqual([]);
  });
});
