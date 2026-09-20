import { expect, it } from 'vitest';
import {
  MetricCollector,
  observeExecution,
  observeStream,
  type MetricEvent,
} from '../src/observability/index';

function fixture() {
  const events: MetricEvent[] = [];
  const collector = new MetricCollector({
    sink: {
      async write(batch) {
        events.push(...batch);
      },
    },
  });
  return { events, collector, context: { collector, operation: 'cli', provider: 'codex' } };
}

it('preserves results and records authoritative usage without inventing output timing or cost', async () => {
  const { context, collector, events } = fixture();
  expect(
    await observeExecution(context, async (observer) => {
      observer.usage({ inputTokens: 12, outputTokens: 3 });
      return 'answer';
    }),
  ).toBe('answer');
  await collector.close();
  expect(events).toMatchObject([
    { outcome: 'success', inputTokens: 12, outputTokens: 3, firstOutputMs: null, estimatedCost: null },
  ]);
});

it('preserves the original execution error and leaves unreported usage unknown', async () => {
  const { context, collector, events } = fixture();
  const failure = new Error('private provider details');
  await expect(
    observeExecution(context, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await collector.close();
  expect(events).toMatchObject([{ outcome: 'error', inputTokens: null, outputTokens: null }]);
  expect(JSON.stringify(events)).not.toContain(failure.message);
});

it('does not record streams that were never consumed and records empty completion as success', async () => {
  const { context, collector, events } = fixture();
  const open = async function* () {
    yield '';
  };
  observeStream(context, open, Boolean);
  await collector.flush();
  expect(events).toEqual([]);
  const values = [];
  for await (const value of observeStream(context, open, Boolean)) values.push(value);
  await collector.close();
  expect(values).toEqual(['']);
  expect(events).toMatchObject([{ outcome: 'success', firstOutputMs: null }]);
});

it('aborts and awaits stream cleanup on early return while recording the first real output', async () => {
  const { context, collector, events } = fixture();
  let closed = false;
  let aborted = false;
  const stream = observeStream(
    context,
    async function* (observer) {
      try {
        yield '';
        yield 'answer';
        yield 'unread';
      } finally {
        await Promise.resolve();
        closed = true;
        aborted = observer.signal.aborted;
      }
    },
    Boolean,
  );
  for await (const value of stream) if (value) break;
  expect({ closed, aborted }).toEqual({ closed: true, aborted: true });
  await collector.close();
  expect(events).toMatchObject([{ outcome: 'cancelled', firstOutputMs: expect.any(Number) }]);
});

it('preserves a failed read when iterator cleanup also fails', async () => {
  const { context, collector, events } = fixture();
  const primary = new Error('read failed');
  const stream = observeStream(
    context,
    () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw primary;
          },
          async return(): Promise<IteratorResult<string>> {
            throw new Error('cleanup failed');
          },
        };
      },
    }),
    Boolean,
  );
  await expect(stream.next()).rejects.toBe(primary);
  await collector.close();
  expect(events).toMatchObject([{ outcome: 'error', errorCode: 'cleanup_failed' }]);
});

it('surfaces cleanup failure when early return has no preceding failure', async () => {
  const { context, collector, events } = fixture();
  const failure = new Error('cleanup failed');
  const stream = observeStream(
    context,
    () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: 'answer' };
          },
          async return(): Promise<IteratorResult<string>> {
            throw failure;
          },
        };
      },
    }),
    Boolean,
  );
  await stream.next();
  await expect(stream.return(undefined)).rejects.toBe(failure);
  await collector.close();
  expect(events).toMatchObject([{ outcome: 'error', errorCode: 'cleanup_failed' }]);
});

it('forwards cancellation to a pending read and preserves its abort reason', async () => {
  const { context, collector, events } = fixture();
  const controller = new AbortController();
  const stream = observeStream(
    { ...context, signal: controller.signal },
    async function* (observer) {
      await new Promise<void>((resolve) => {
        observer.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      observer.signal.throwIfAborted();
      yield 'unreachable';
    },
    Boolean,
  );
  const next = stream.next();
  controller.abort(new Error('request stopped'));
  await expect(next).rejects.toBe(controller.signal.reason);
  await collector.close();
  expect(events).toMatchObject([{ outcome: 'cancelled' }]);
});

it('preserves application success when telemetry rejects the event', async () => {
  const { context, collector, events } = fixture();
  expect(await observeExecution({ ...context, provider: 'invalid provider' }, async () => 42)).toBe(42);
  await collector.close();
  expect(events).toEqual([]);
  expect(collector.status().rejected).toBe(1);
});

it('cancels a pending read before waiting for iterator return', async () => {
  const { context, collector, events } = fixture();
  let cleaned = false;
  const stream = observeStream(
    context,
    async function* (observer) {
      try {
        await new Promise<void>((resolve) => {
          observer.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        observer.signal.throwIfAborted();
        yield 'unreachable';
      } finally {
        cleaned = true;
      }
    },
    Boolean,
  );
  const next = stream.next();
  const returned = stream.return(undefined);
  await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  await expect(returned).resolves.toMatchObject({ done: true });
  expect(cleaned).toBe(true);
  await collector.close();
  expect(events).toMatchObject([{ outcome: 'cancelled' }]);
});
