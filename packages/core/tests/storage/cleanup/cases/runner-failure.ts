import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  CleanupExecutionJournal,
  runStorageCleanup,
  type StorageCleanupBackendPort,
} from '../../../../src/storage';
import type { fixture } from '../cleanup-runner.test';

export function registerFailedDeleteCase(createFixture: typeof fixture) {
  it('leaves backend ownership unresolved after a failed delete', async () => {
    const item = await createFixture();
    const executorId = randomUUID();
    const failure = new Error('delete response was lost');
    const port: StorageCleanupBackendPort = {
      backendId: item.backend.id,
      binding: item.backend.binding,
      collect: async () => ({ targets: [item.target], next: null }),
      delete: vi.fn().mockRejectedValue(failure),
    };
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        executorId,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [port],
      }),
    ).rejects.toBe(failure);
    const replacement = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: item.job.id,
      backendBinding: item.backend.binding,
    };
    await expect(
      item.transaction((tx) => new CleanupExecutionJournal(tx, 'sqlite', 'app').begin(replacement)),
    ).rejects.toThrow('unresolved');
    const unresolved = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
      item.backend.binding,
    );
    expect(unresolved).toMatchObject({
      executorId,
      jobId: item.job.id,
      backendBinding: item.backend.binding,
      status: 'unconfirmed',
    });
  });
}
