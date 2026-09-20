import { z } from 'zod';
import type { StateStore } from '../storage/index';
import { metricEventSchema, type MetricEvent, type MetricSink } from './index';

export const metricStateSchema = z.object({ version: z.literal(1), events: z.array(metricEventSchema) });
export type MetricState = z.infer<typeof metricStateSchema>;
export const initialMetricState = (): MetricState => ({ version: 1, events: [] });

export interface LocalMetricOptions {
  store: StateStore<MetricState>;
  retentionMs?: number;
  maxEvents?: number;
  now?: () => number;
}
export class LocalMetricStore implements MetricSink {
  private readonly retention: number;
  private readonly capacity: number;
  private readonly now: () => number;
  constructor(private readonly options: LocalMetricOptions) {
    this.retention = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.capacity = options.maxEvents ?? 50_000;
    this.now = options.now ?? Date.now;
    if (![this.retention, this.capacity].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new Error('Metric retention and capacity must be positive integers');
  }

  async write(events: readonly MetricEvent[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const safe = events.map((event) => metricEventSchema.parse(event));
    await this.options.store.transact((state) => {
      signal.throwIfAborted();
      const retained = state.events.filter((event) => event.timestamp >= this.now() - this.retention);
      const ids = new Set(retained.map((event) => event.id));
      for (const event of safe) {
        if (
          ids.has(event.id) ||
          event.timestamp < this.now() - this.retention ||
          event.timestamp > this.now() + 60_000
        )
          continue;
        retained.push(event);
        ids.add(event.id);
      }
      state.events = retained.sort((a, b) => a.timestamp - b.timestamp).slice(-this.capacity);
    });
  }

  async query(
    filter: { consumerId?: string; provider?: string; since?: number; limit?: number } = {},
  ): Promise<MetricEvent[]> {
    const limit = Math.min(10_000, Math.max(1, filter.limit ?? 1000));
    const cutoff = Math.max(filter.since ?? 0, this.now() - this.retention);
    return (await this.options.store.read()).events
      .filter(
        (event) =>
          event.timestamp >= cutoff &&
          (filter.consumerId === undefined || event.consumerId === filter.consumerId) &&
          (filter.provider === undefined || event.provider === filter.provider),
      )
      .slice(-limit);
  }

  async eraseConsumer(consumerId: string): Promise<void> {
    await this.options.store.transact((state) => {
      state.events = state.events.filter((event) => event.consumerId !== consumerId);
    });
  }

  async prune(): Promise<void> {
    await this.options.store.transact((state) => {
      state.events = state.events
        .filter((event) => event.timestamp >= this.now() - this.retention)
        .slice(-this.capacity);
    });
  }
}
