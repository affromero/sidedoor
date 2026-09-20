import { z } from 'zod';
export { observeExecution, observeStream } from './execution';
export type { ExecutionContext, ExecutionObserver } from './execution';

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const measurement = z.number().finite().nonnegative().nullable();

/** No arbitrary metadata, content, exception messages, URLs, or credential fields. */
export const metricEventSchema = z.object({
  version: z.literal(1),
  id: identifier,
  timestamp: z.number().int().nonnegative(),
  kind: z.enum(['execution', 'access', 'setup', 'delivery', 'health']),
  operation: identifier,
  outcome: z.enum(['success', 'error', 'cancelled']),
  provider: identifier.optional(),
  model: z
    .string()
    .regex(/^[a-zA-Z0-9_.:/@+-]{1,256}$/)
    .optional(),
  consumerId: identifier.optional(),
  credentialOwnerId: identifier.optional(),
  durationMs: measurement.optional(),
  firstOutputMs: measurement.optional(),
  queueMs: measurement.optional(),
  retryCount: z.number().int().nonnegative().optional(),
  inputTokens: measurement.optional(),
  outputTokens: measurement.optional(),
  cachedInputTokens: measurement.optional(),
  cacheWriteTokens: measurement.optional(),
  reasoningTokens: measurement.optional(),
  audioSeconds: measurement.optional(),
  estimatedCost: measurement.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  pricingVersion: identifier.optional(),
  errorCode: identifier.optional(),
});

export type MetricEvent = z.infer<typeof metricEventSchema>;
export interface MetricSink {
  /** Persist by event ID for idempotence. Must honor cancellation. */
  write(events: readonly MetricEvent[], signal: AbortSignal): Promise<void>;
}

export interface CollectorOptions {
  sink: MetricSink;
  capacity?: number;
  batchSize?: number;
  timeoutMs?: number;
}

/** Explicit local sink; never starts a network exporter or background timer. */
export class MetricCollector {
  private readonly pending: MetricEvent[] = [];
  private running: Promise<void> | undefined;
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private dropped = 0;
  private rejected = 0;
  private failures = 0;
  private closed = false;

  constructor(private readonly options: CollectorOptions) {
    this.capacity = options.capacity ?? 1_000;
    this.batchSize = options.batchSize ?? 100;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    for (const value of [this.capacity, this.batchSize, this.timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('Collector limits must be positive integers');
    }
  }

  record(value: unknown): boolean {
    const parsed = metricEventSchema.safeParse(value);
    if (!parsed.success) {
      this.rejected++;
      return false;
    }
    if (this.closed || this.pending.length >= this.capacity) {
      this.dropped++;
      return false;
    }
    this.pending.push(parsed.data);
    return true;
  }

  status() {
    return {
      pending: this.pending.length,
      dropped: this.dropped,
      rejected: this.rejected,
      failures: this.failures,
      closed: this.closed,
    };
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    if (this.pending.length) await this.flush();
  }

  private async drain(): Promise<void> {
    // Snapshot budget prevents producers from keeping a flush alive forever.
    let remaining = this.pending.length;
    const deadline = Date.now() + this.timeoutMs;
    while (remaining > 0) {
      if (Date.now() >= deadline) {
        this.pending.splice(0, remaining);
        this.dropped += remaining;
        break;
      }
      const batch = this.pending.splice(0, Math.min(remaining, this.batchSize));
      remaining -= batch.length;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.options.sink.write(batch, controller.signal),
          new Promise<void>((resolve) => {
            timer = setTimeout(
              () => {
                controller.abort(new Error('Telemetry flush timed out'));
                resolve();
              },
              Math.max(1, deadline - Date.now()),
            );
          }).then(() => {
            throw controller.signal.reason;
          }),
        ]);
      } catch {
        this.failures++;
        this.dropped += batch.length;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

export function sumKnownCosts(events: readonly MetricEvent[]): number | null {
  if (!events.length) return null;
  let total = 0;
  const currency = events[0]?.currency;
  for (const event of events) {
    if (event.estimatedCost === null || event.estimatedCost === undefined || event.currency !== currency)
      return null;
    total += event.estimatedCost;
  }
  return Number.isFinite(total) ? total : null;
}
