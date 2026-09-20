import { z } from 'zod';

const referenceSchema = z
  .object({
    id: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const pageSchema = z
  .object({
    jobs: z.array(referenceSchema).max(100),
    cursor: z.uuid().nullable(),
  })
  .strict();

export type JobDeliveryReference = z.infer<typeof referenceSchema>;
export type JobDeliveryOutcome = 'delivered' | 'complete' | 'erased';
export type JobDeliveryResult = JobDeliveryReference &
  ({ status: JobDeliveryOutcome } | { status: 'failed'; error: unknown });

/** Reconcile one bounded page outside the listing transaction. The caller owns the cursor. */
export async function reconcileOutboxPage(options: {
  cursor: string | null;
  signal: AbortSignal;
  listIncomplete: (cursor: string | null) => Promise<z.infer<typeof pageSchema>>;
  deliver: (reference: JobDeliveryReference, signal: AbortSignal) => Promise<JobDeliveryOutcome>;
}): Promise<{ cursor: string | null; results: JobDeliveryResult[] }> {
  z.uuid().nullable().parse(options.cursor);
  const results: JobDeliveryResult[] = [];
  if (options.signal.aborted) return { cursor: options.cursor, results };
  const page = pageSchema.parse(await options.listIncomplete(options.cursor));
  if (options.signal.aborted) return { cursor: options.cursor, results };
  if (new Set(page.jobs.map((job) => job.id)).size !== page.jobs.length)
    throw new Error('Outbox reconciliation page contains duplicate identities');
  if (page.cursor !== null && page.cursor !== page.jobs.at(-1)?.id)
    throw new Error('Outbox reconciliation cursor does not match its page');
  let previous = options.cursor;
  for (const reference of page.jobs) {
    if (previous !== null && reference.id <= previous)
      throw new Error('Outbox reconciliation page does not advance in identity order');
    previous = reference.id;
  }
  let cursor = options.cursor;
  for (const reference of page.jobs) {
    if (options.signal.aborted) return { cursor, results };
    try {
      const status = z
        .enum(['delivered', 'complete', 'erased'])
        .parse(await options.deliver(Object.freeze({ ...reference }), options.signal));
      results.push({ ...reference, status });
    } catch (error) {
      results.push({ ...reference, status: 'failed', error });
    }
    cursor = reference.id;
  }
  return { cursor: page.cursor, results };
}
