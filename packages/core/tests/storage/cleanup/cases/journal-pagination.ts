import { expect, it } from 'vitest';
import type { fixture } from '../cleanup-journal.test';

export function registerPaginationCase(createFixture: typeof fixture) {
  it('reopens rediscovered objects and rejects acknowledgements from the previous deletion pass', async () => {
    const { journal, transaction, page, deleting } = await createFixture();
    let job = await deleting();
    const old = (await journal.pendingTargets(job.id, job.epoch)).tickets[0]!;
    await transaction(() => journal.acknowledgeTarget(old));
    job = await transaction(() => journal.beginVerification(job.id, job.epoch));
    job = await page(job, 'inventory');
    job = await transaction(() => journal.transition(job.id, job.epoch));
    expect(job).toMatchObject({ phase: 'deleting', pending: 1, deleted: 0 });
    await expect(transaction(() => journal.acknowledgeTarget(old))).rejects.toThrow('phase changed');
    const current = (await journal.pendingTargets(job.id, job.epoch)).tickets[0]!;
    expect(current.revision).not.toBe(old.revision);
    await transaction(() => journal.acknowledgeTarget(current));
    job = await transaction(() => journal.beginVerification(job.id, job.epoch));
    await page(job, 'inventory', []);
    expect(await transaction(() => journal.transition(job.id, job.epoch))).toMatchObject({
      phase: 'complete',
      verification: 2,
    });
  });

  it('bounds manifest reads and resumes across acknowledged rows', async () => {
    const { journal, target, page, transaction, collecting } = await createFixture();
    let job = await collecting();
    job = await page(
      job,
      'inventory',
      Array.from({ length: 205 }, (_, index) => ({ ...target, key: `recordings/learner/${index}.wav` })),
    );
    job = await transaction(() => journal.transition(job.id, job.epoch));
    job = await transaction(() => journal.transition(job.id, job.epoch));
    const first = await journal.pendingTargets(job.id, job.epoch);
    expect(first.tickets).toHaveLength(100);
    await transaction(async () => {
      for (const ticket of first.tickets) await journal.acknowledgeTarget(ticket);
    });
    expect((await journal.pendingTargets(job.id, job.epoch)).tickets).toHaveLength(0);
    const second = await journal.pendingTargets(job.id, job.epoch, first.cursor);
    const third = await journal.pendingTargets(job.id, job.epoch, second.cursor);
    expect(second.tickets).toHaveLength(100);
    expect(third.tickets).toHaveLength(6);
    expect(third.cursor).toBeNull();
    await expect(journal.pendingTargets(job.id, job.epoch, `different:${first.cursor}`)).rejects.toThrow(
      'another namespace',
    );
  });
}
