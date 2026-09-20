import { expect, it } from 'vitest';
import { runTaskLoop } from '../../../src/runtime/jobs/task-loop';

it.each([0, 1.5, 2_147_483_648, Infinity, NaN])(
  'rejects unsupported timer interval %s before running work',
  async (intervalMs) => {
    let changed = false;
    await expect(
      runTaskLoop({
        intervalMs,
        signal: new AbortController().signal,
        task: () => {
          changed = true;
        },
        onError() {},
      }),
    ).rejects.toThrow('Task interval');
    expect(changed).toBe(false);
  },
);

it('waits for active work to finish when shutdown is requested', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const active = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed = false;
  const loop = runTaskLoop({
    intervalMs: 1,
    signal: controller.signal,
    task: async () => {
      await active;
      completed = true;
    },
    onError: () => {
      throw new Error('Unexpected task failure');
    },
  });
  controller.abort();
  expect(completed).toBe(false);
  finish();
  await loop;
  expect(completed).toBe(true);
});

it('reports a synchronous failure and retries without overlapping work', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const keepAlive = setTimeout(() => controller.abort(), 1000);
  try {
    await runTaskLoop({
      intervalMs: 1,
      signal: controller.signal,
      task: () => {
        if (events.length === 0) throw new Error('Storage unavailable');
        events.push('retried');
        controller.abort();
      },
      onError: (error) => {
        events.push((error as Error).message);
      },
    });
    expect(events).toEqual(['Storage unavailable', 'retried']);
  } finally {
    clearTimeout(keepAlive);
  }
});

it('rejects visibly when error reporting itself fails', async () => {
  await expect(
    runTaskLoop({
      intervalMs: 1,
      signal: new AbortController().signal,
      task: async () => {
        throw new Error('Task failed');
      },
      onError: () => {
        throw new Error('Reporter failed');
      },
    }),
  ).rejects.toThrow('Reporter failed');
});

it('does not start work when already stopped', async () => {
  const controller = new AbortController();
  controller.abort();
  let changed = false;
  await runTaskLoop({
    intervalMs: 1,
    signal: controller.signal,
    task: () => {
      changed = true;
    },
    onError() {},
  });
  expect(changed).toBe(false);
});
