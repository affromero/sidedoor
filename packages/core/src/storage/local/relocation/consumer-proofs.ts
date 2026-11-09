import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { cleanupRows } from '../../cleanup/cleanup-collectors';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../../sql/sql';

const identity = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('storage_relocation_consumer_proof'),
    namespace: identity,
    operationId: z.uuid(),
    consumer: identity,
    sourceAssetId: digest,
    destinationAssetId: digest,
    content: z.object({ sha256: digest, bytes: z.number().int().nonnegative().safe() }).strict(),
  })
  .strict();
type Receipt = {
  operationId: string;
  sourceAssetId: string;
  destinationAssetId: string;
  content: { sha256: string; bytes: number };
  proofConsumers?: string[];
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Operation-indexed proof records. The relocation receipt remains their lifecycle owner. */
export class RelocationConsumerProofs {
  private readonly namespacePrefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    this.namespacePrefix = `sd-rel-consumer:2:${hash(identity.parse(namespace))}:`;
  }
  private prefix(operationId: string) {
    return `${this.namespacePrefix}${z.uuid().parse(operationId)}:`;
  }
  id(operationId: string, consumer: string) {
    return `${this.prefix(operationId)}${hash(identity.parse(consumer))}`;
  }
  backend(operationId: string, consumer: string) {
    return sqlStateBackend(this.database, this.dialect, this.id(operationId, consumer));
  }
  value(receipt: Receipt, consumer: string) {
    return proofSchema.parse({
      schemaVersion: 2,
      kind: 'storage_relocation_consumer_proof',
      namespace: this.namespace,
      operationId: receipt.operationId,
      consumer,
      sourceAssetId: receipt.sourceAssetId,
      destinationAssetId: receipt.destinationAssetId,
      content: receipt.content,
    });
  }
  parse(value: unknown) {
    return proofSchema.parse(value);
  }
  private decode(row: Record<string, unknown>) {
    const value: unknown =
      this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
    const proof = proofSchema.parse(value);
    if (proof.namespace !== this.namespace || row.id !== this.id(proof.operationId, proof.consumer))
      throw new Error('Storage relocation consumer proof identity mismatch');
    return proof;
  }
  async list(operationId: string, after: string | null = null) {
    const prefix = this.prefix(operationId);
    const rows = await cleanupRows(this.database, this.dialect, prefix, after);
    const proofs = rows.map((row) => {
      const proof = this.decode(row);
      if (proof.operationId !== operationId)
        throw new Error('Storage relocation consumer proof identity mismatch');
      return proof;
    });
    return { proofs, cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null };
  }
  /** Discover all proof records, including orphans with missing receipt indexes. */
  async listAll(after: string | null = null) {
    const rows = await sqlStateRows(
      this.database,
      this.dialect,
      this.namespacePrefix,
      after,
      100,
      'uuidDigest',
    );
    return {
      proofs: rows.map((row) => this.decode(row)),
      cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null,
    };
  }
  async requireMembership(receipt: Receipt) {
    const found = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.list(receipt.operationId, cursor);
      for (const proof of page.proofs) {
        if (
          !receipt.proofConsumers?.includes(proof.consumer) ||
          !isDeepStrictEqual(proof, this.value(receipt, proof.consumer))
        )
          throw new Error('Storage relocation consumer proof membership does not match');
        found.add(proof.consumer);
      }
      if (page.cursor !== null && cursor !== null && page.cursor <= cursor)
        throw new Error('Storage relocation consumer proof cursor did not advance');
      cursor = page.cursor;
    } while (cursor !== null);
    if ((receipt.proofConsumers?.length ?? 0) !== found.size)
      throw new Error('Storage relocation consumer proof membership does not match');
  }
}
