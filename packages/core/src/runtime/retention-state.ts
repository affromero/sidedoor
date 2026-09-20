import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './json';
import { sqlStateBackend, type SqlExecutor } from '../storage/sql';

export const retentionPolicy = 'job-id-snapshots-v1' as const;
export const retentionStateSchema = z
  .object({
    kind: z.literal('job_retention'),
    policy: z.literal(retentionPolicy),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['backfill', 'jobs', 'complete']),
    cursor: z.uuid().nullable(),
    activeId: z.uuid().nullable(),
  })
  .strict();
export function retentionBinding(job: {
  id: string;
  namespace: string;
  subjectId: string;
  generation: number;
}) {
  return createHash('sha256')
    .update(
      canonicalJson({
        id: job.id,
        namespace: job.namespace,
        subjectId: job.subjectId,
        generation: job.generation,
        policy: retentionPolicy,
      }),
    )
    .digest('hex');
}
export function retentionBackend(
  database: SqlExecutor,
  dialect: 'postgres' | 'sqlite',
  namespace: string,
  id: string,
) {
  const digest = createHash('sha256').update(z.string().min(1).max(200).parse(namespace)).digest('hex');
  return sqlStateBackend(database, dialect, `sd-jr:1:${digest}:${z.uuid().parse(id)}`);
}
