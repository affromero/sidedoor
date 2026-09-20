import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LocalMetricStore, metricStateSchema, initialMetricState } from '../../src/observability/store';
import { FileStateStore } from '../../src/storage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('deduplicates local usage, enforces retention, and erases one consumer without affecting another', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-metrics-'));
  directories.push(directory);
  let now = 10_000;
  const store = new FileStateStore({
    path: join(directory, 'metrics.json'),
    initial: initialMetricState,
    parse: (value) => metricStateSchema.parse(value),
  });
  const metrics = new LocalMetricStore({ store, now: () => now, retentionMs: 1000, maxEvents: 3 });
  const base = {
    version: 1,
    timestamp: now,
    kind: 'execution',
    operation: 'generate',
    outcome: 'success',
    consumerId: 'alice',
  } as const;
  await metrics.write(
    [
      { ...base, id: 'old', timestamp: 1 },
      { ...base, id: 'alice-1' },
      { ...base, id: 'bob-1', consumerId: 'bob' },
    ],
    new AbortController().signal,
  );
  await metrics.write([{ ...base, id: 'alice-1' }], new AbortController().signal);
  expect((await metrics.query()).map((event) => event.id)).toEqual(['alice-1', 'bob-1']);
  expect((await metrics.query({ consumerId: 'alice' })).map((event) => event.id)).toEqual(['alice-1']);
  await metrics.eraseConsumer('alice');
  expect((await metrics.query()).map((event) => event.id)).toEqual(['bob-1']);
  now += 1001;
  await metrics.prune();
  expect((await store.read()).events).toEqual([]);
});
