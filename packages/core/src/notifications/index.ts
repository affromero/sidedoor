import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StateStore } from '../storage/index';
import type { MetricCollector } from '../observability/index';
import { abortable } from '../runtime/abort';

const messageSchema = z.object({
  title: z.string().max(300),
  body: z.string().max(20_000),
  url: z.string().max(2000).optional(),
});
export type NotificationMessage = z.infer<typeof messageSchema>;
const entrySchema = z.object({
  id: z.string(),
  recipientId: z.string(),
  topic: z.string(),
  message: messageSchema,
  createdAt: z.number(),
  readAt: z.number().nullable(),
});
const deliverySchema = z.object({
  id: z.string(),
  notificationId: z.string(),
  channelId: z.string(),
  attempts: z.number().int(),
  status: z.enum(['pending', 'delivered', 'failed']),
  nextAttemptAt: z.number(),
  lease: z.string().nullable(),
  leaseUntil: z.number(),
  errorCode: z.string().nullable(),
});
export const notificationStateSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
  deliveries: z.array(deliverySchema),
});
export type NotificationState = z.infer<typeof notificationStateSchema>;
export const initialNotificationState = (): NotificationState => ({
  version: 1,
  entries: [],
  deliveries: [],
});
export type NotificationEntry = z.infer<typeof entrySchema>;
export type DeliveryResult =
  | { status: 'delivered' }
  | { status: 'retry'; code: string; retryAfterMs?: number }
  | { status: 'failed'; code: string };
export interface DeliveryTransport {
  send(input: {
    channelId: string;
    message: NotificationMessage;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<DeliveryResult>;
}
export interface NotificationOptions {
  store: StateStore<NotificationState>;
  now?: () => number;
  metrics?: MetricCollector;
}

/** Recipient selection and HTTP authorization remain with the app. Every inbox operation is scoped. */
export class NotificationCenter {
  private readonly now: () => number;
  constructor(private readonly options: NotificationOptions) {
    this.now = options.now ?? Date.now;
  }

  async create(
    recipientId: string,
    topic: string,
    message: NotificationMessage,
    channels: readonly string[] = [],
  ): Promise<string> {
    if (!recipientId || !topic) throw new Error('Recipient and topic are required');
    const safe = messageSchema.parse(message);
    return this.options.store.transact((state) => {
      const id = randomUUID();
      state.entries.push({ id, recipientId, topic, message: safe, createdAt: this.now(), readAt: null });
      state.deliveries.push(
        ...[...new Set(channels)].map((channelId) => ({
          id: randomUUID(),
          notificationId: id,
          channelId,
          attempts: 0,
          status: 'pending' as const,
          nextAttemptAt: this.now(),
          lease: null,
          leaseUntil: 0,
          errorCode: null,
        })),
      );
      return id;
    });
  }

  async list(recipientId: string, limit = 100): Promise<NotificationEntry[]> {
    return (await this.options.store.read()).entries
      .filter((entry) => entry.recipientId === recipientId)
      .slice(-Math.min(1000, Math.max(1, limit)))
      .reverse();
  }

  async unreadCount(recipientId: string): Promise<number> {
    return (await this.options.store.read()).entries.filter(
      (entry) => entry.recipientId === recipientId && entry.readAt === null,
    ).length;
  }

  async markRead(recipientId: string, id?: string): Promise<void> {
    await this.options.store.transact((state) => {
      for (const entry of state.entries) {
        if (
          entry.recipientId === recipientId &&
          (id === undefined || entry.id === id) &&
          entry.readAt === null
        )
          entry.readAt = this.now();
      }
    });
  }

  async eraseRecipient(recipientId: string): Promise<void> {
    await this.options.store.transact((state) => {
      const removed = new Set(
        state.entries.filter((entry) => entry.recipientId === recipientId).map((entry) => entry.id),
      );
      state.entries = state.entries.filter((entry) => !removed.has(entry.id));
      state.deliveries = state.deliveries.filter((delivery) => !removed.has(delivery.notificationId));
    });
  }

  /** Delivery is at least once; transports receive a stable idempotency key for deduplication. */
  async deliverNext(transport: DeliveryTransport, parent?: AbortSignal): Promise<boolean> {
    parent?.throwIfAborted();
    const lease = randomUUID();
    const claimed = await this.options.store.transact((state) => {
      const delivery = state.deliveries.find(
        (item) =>
          item.status === 'pending' && item.nextAttemptAt <= this.now() && item.leaseUntil <= this.now(),
      );
      if (!delivery) return null;
      const entry = state.entries.find((item) => item.id === delivery.notificationId);
      if (!entry) throw new Error('Notification delivery references missing content');
      delivery.lease = lease;
      delivery.leaseUntil = this.now() + 30_000;
      delivery.attempts++;
      return { delivery, entry };
    });
    if (!claimed) return false;
    const started = this.now();
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(parent ? [parent] : [])]);
    let result: DeliveryResult;
    try {
      result = await abortable(
        transport.send({
          channelId: claimed.delivery.channelId,
          message: claimed.entry.message,
          idempotencyKey: claimed.delivery.id,
          signal,
        }),
        signal,
      );
    } catch {
      result = { status: 'retry', code: signal.aborted ? 'cancelled' : 'transport_error' };
    }
    await this.options.store.transact((state) => {
      const delivery = state.deliveries.find((item) => item.id === claimed.delivery.id);
      if (!delivery || delivery.lease !== lease) return;
      delivery.lease = null;
      delivery.leaseUntil = 0;
      if (result.status === 'delivered') {
        delivery.status = 'delivered';
        delivery.errorCode = null;
        return;
      }
      delivery.errorCode = /^[a-zA-Z0-9_.:-]{1,128}$/.test(result.code) ? result.code : 'transport_error';
      delivery.status = result.status === 'failed' || delivery.attempts >= 5 ? 'failed' : 'pending';
      const retryMs =
        result.status === 'retry' && Number.isFinite(result.retryAfterMs)
          ? Math.max(1000, Math.min(result.retryAfterMs!, 24 * 60 * 60 * 1000))
          : Math.min(60_000 * 2 ** (delivery.attempts - 1), 60 * 60 * 1000);
      delivery.nextAttemptAt = this.now() + retryMs;
    });
    this.options.metrics?.record({
      version: 1,
      id: randomUUID(),
      timestamp: this.now(),
      kind: 'delivery',
      operation: 'notification',
      consumerId: claimed.entry.recipientId,
      outcome: result.status === 'delivered' ? 'success' : signal.aborted ? 'cancelled' : 'error',
      durationMs: this.now() - started,
    });
    return true;
  }
}
