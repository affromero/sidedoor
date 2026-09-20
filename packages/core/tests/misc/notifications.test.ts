import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotificationCenter,
  initialNotificationState,
  notificationStateSchema,
} from '../../src/notifications/index';
import { FileStateStore } from '../../src/storage/index';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sidedoor-notifications-'));
  directories.push(dir);
  const store = new FileStateStore({
    path: join(dir, 'state.json'),
    initial: initialNotificationState,
    parse: (value) => notificationStateSchema.parse(value),
  });
  return { center: new NotificationCenter({ store }), store };
}

describe('notification delivery and inbox', () => {
  it('keeps inbox and read state isolated between recipients', async () => {
    const { center } = await fixture();
    const first = await center.create('alice', 'ready', { title: 'Ready', body: 'Alice content' });
    await center.create('bob', 'ready', { title: 'Ready', body: 'Bob content' });
    await center.markRead('bob', first);
    expect(await center.unreadCount('alice')).toBe(1);
    expect((await center.list('alice')).map((item) => item.message.body)).toEqual(['Alice content']);
    await center.markRead('alice', first);
    expect(await center.unreadCount('alice')).toBe(0);
    expect(await center.unreadCount('bob')).toBe(1);
  });

  it('claims a delivery once across concurrent workers', async () => {
    const { center, store } = await fixture();
    await center.create('alice', 'ready', { title: 'Ready', body: 'Content' }, ['email']);
    const sent: string[] = [];
    const transport = {
      async send(input: { idempotencyKey: string }) {
        sent.push(input.idempotencyKey);
        return { status: 'delivered' as const };
      },
    };
    await Promise.all([center.deliverNext(transport), center.deliverNext(transport)]);
    expect(sent).toHaveLength(1);
    expect((await store.read()).deliveries[0]?.status).toBe('delivered');
  });
});
