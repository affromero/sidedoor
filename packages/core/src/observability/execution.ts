import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '../ai/index';
import { sumTokenUsage } from '../ai/usage';
import type { MetricCollector, MetricEvent } from './index';

export interface ExecutionContext {
  collector: MetricCollector;
  operation: string;
  provider?: string;
  model?: string;
  consumerId?: string;
  credentialOwnerId?: string;
  signal?: AbortSignal;
}

export interface ExecutionObserver {
  readonly signal: AbortSignal;
  output(): void;
  /** Supply authoritative final measurements, never estimates from text length. */
  usage(value: TokenUsage): void;
}

function observation(context: ExecutionContext) {
  const started = performance.now();
  const controller = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  let firstOutputMs: number | null = null;
  let usage: TokenUsage = sumTokenUsage({ inputTokens: null, outputTokens: null });
  const observer: ExecutionObserver = {
    signal,
    output() {
      firstOutputMs ??= performance.now() - started;
    },
    usage(value) {
      usage = sumTokenUsage(value);
    },
  };
  return {
    observer,
    abort: () => controller.abort(),
    finish(outcome: MetricEvent['outcome'], cleanupFailed = false) {
      context.collector.record({
        version: 1,
        id: randomUUID(),
        timestamp: Date.now(),
        kind: 'execution',
        operation: context.operation,
        provider: context.provider,
        model: context.model,
        consumerId: context.consumerId,
        credentialOwnerId: context.credentialOwnerId,
        outcome,
        durationMs: performance.now() - started,
        firstOutputMs,
        ...usage,
        estimatedCost: null,
        ...(cleanupFailed ? { errorCode: 'cleanup_failed' } : {}),
      });
    },
  };
}

export async function observeExecution<T>(
  context: ExecutionContext,
  run: (observer: ExecutionObserver) => Promise<T>,
): Promise<T> {
  const state = observation(context);
  let outcome: MetricEvent['outcome'] = 'error';
  try {
    state.observer.signal.throwIfAborted();
    const value = await run(state.observer);
    state.observer.signal.throwIfAborted();
    outcome = 'success';
    return value;
  } catch (error) {
    outcome = state.observer.signal.aborted ? 'cancelled' : 'error';
    throw error;
  } finally {
    state.abort();
    state.finish(outcome);
  }
}

async function closeIterator<T>(
  iterator: AsyncIterator<T> | undefined,
  failed: boolean,
  report: () => void,
): Promise<void> {
  try {
    await iterator?.return?.();
  } catch (error) {
    report();
    if (!failed) throw error;
  }
}

/** Abort before queuing return behind a pending read. Adapters must honor observer.signal. */
export function observeStream<T>(
  context: ExecutionContext,
  open: (observer: ExecutionObserver) => AsyncIterable<T>,
  isOutput: (value: T) => boolean,
): AsyncGenerator<T> {
  const controller = new AbortController();
  const stream = observedStream(
    {
      ...context,
      signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
    },
    open,
    isOutput,
  );
  const finish = stream.return.bind(stream);
  const fail = stream.throw.bind(stream);
  stream.return = (value) => {
    controller.abort();
    return finish(value);
  };
  stream.throw = (error) => {
    controller.abort(error);
    return fail(error);
  };
  return stream;
}

async function* observedStream<T>(
  context: ExecutionContext,
  open: (observer: ExecutionObserver) => AsyncIterable<T>,
  isOutput: (value: T) => boolean,
): AsyncGenerator<T> {
  const state = observation(context);
  let outcome: MetricEvent['outcome'] = 'cancelled';
  let iterator: AsyncIterator<T> | undefined;
  let failed = false;
  let exhausted = false;
  let cleanupFailed = false;
  try {
    state.observer.signal.throwIfAborted();
    iterator = open(state.observer)[Symbol.asyncIterator]();
    while (true) {
      state.observer.signal.throwIfAborted();
      const next = await iterator.next();
      state.observer.signal.throwIfAborted();
      if (next.done) {
        exhausted = true;
        outcome = 'success';
        return;
      }
      if (isOutput(next.value)) state.observer.output();
      yield next.value;
    }
  } catch (error) {
    failed = true;
    outcome = state.observer.signal.aborted ? 'cancelled' : 'error';
    throw error;
  } finally {
    state.abort();
    try {
      if (!exhausted)
        await closeIterator(iterator, failed, () => {
          cleanupFailed = true;
          if (!failed) outcome = 'error';
        });
    } finally {
      state.finish(outcome, cleanupFailed);
    }
  }
}
