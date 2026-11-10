import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { StorageReferenceRegistry } from '../../registry/reference-registry';
import type { StorageRelocationRegistry } from '../relocation';
import type { StorageWriteJournal } from '../../execution/write-journal';

type Receipt = Awaited<ReturnType<StorageRelocationRegistry['listAll']>>['receipts'][number];

export interface BackwardRelocationInput {
  consumer: string;
  currentReference: string;
  maxHops: number;
  signal?: AbortSignal;
}

interface BackwardRelocationPorts {
  references: StorageReferenceRegistry;
  writes: StorageWriteJournal;
  readEdge(sourceAssetId: string, consumer: string): Promise<Receipt | null>;
  verify(receipt: Receipt): Promise<void>;
}

/**
 * Trace internally consistent relocation evidence in the caller's Serializable snapshot.
 * A boundary does not prove earlier history is absent, and recorded content is not an
 * independent readback. The caller must verify application ownership and copy evidence.
 */
export async function traceBackwardRelocation(
  input: BackwardRelocationInput,
  ports: BackwardRelocationPorts,
) {
  const consumer = z.string().min(1).max(200).parse(input.consumer);
  const reference = z.string().min(1).parse(input.currentReference);
  const maxHops = z.number().int().min(1).max(10_000).parse(input.maxHops);
  const signal = input.signal;
  const read = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    signal?.throwIfAborted();
    try {
      const value = await operation();
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  };
  const terminal = await read(() => ports.references.resolve({ consumer, reference }));
  if (!terminal) throw new Error('Storage relocation current reference is missing');
  for (const scope of terminal.prepared.scopes) {
    if (await read(() => ports.writes.tombstone(scope.subjectId)))
      throw new Error('Storage relocation ownership was erased');
  }
  let current = { id: terminal.assetId, prepared: terminal.prepared };
  const visited = new Set<string>();
  const edges: Receipt[] = [];
  let content: Receipt['content'] | null = null;
  while (true) {
    signal?.throwIfAborted();
    if (visited.has(current.id)) throw new Error('Storage relocation chain contains a cycle');
    visited.add(current.id);
    const allocation = await read(() => ports.references.readAllocation(current.id));
    if (!allocation || allocation.operationId !== current.prepared.operationId)
      throw new Error('Storage relocation allocation is missing or changed');
    const claim = allocation.claims.find((item) => item.consumer === consumer);
    if (!claim) throw new Error('Storage relocation consumer allocation is missing');
    const previousReference = claim.previousReference;
    if (previousReference === null)
      return {
        terminal,
        edges: edges.reverse(),
        boundary: {
          kind: 'allocation-origin' as const,
          assetId: current.id,
          reference: current.prepared.reference,
        },
      };
    if (previousReference === current.prepared.reference)
      return {
        terminal,
        edges: edges.reverse(),
        boundary: {
          kind: 'unverified-replacement' as const,
          assetId: current.id,
          reference: current.prepared.reference,
          previousReference,
        },
      };
    const previous = await read(() => ports.references.readReference(previousReference));
    if (!previous) throw new Error('Storage relocation previous reference is missing');
    if (visited.has(previous.asset.id)) throw new Error('Storage relocation chain contains a cycle');
    const receipt = await read(() => ports.readEdge(previous.asset.id, consumer));
    if (!receipt)
      return {
        terminal,
        edges: edges.reverse(),
        boundary: {
          kind: 'unverified-replacement' as const,
          assetId: current.id,
          reference: current.prepared.reference,
          previousReference,
        },
      };
    if (edges.length >= maxHops)
      throw new Error('Storage relocation chain exceeds the configured traversal limit');
    if (
      receipt.sourceAssetId !== previous.asset.id ||
      receipt.destinationAssetId !== current.id ||
      !receipt.consumers.includes(consumer)
    )
      throw new Error('Storage relocation chain identity does not match');
    await read(() => ports.verify(receipt));
    if (content && !isDeepStrictEqual(content, receipt.content))
      throw new Error('Storage relocation chain content changed');
    content = receipt.content;
    edges.push(receipt);
    current = { id: previous.asset.id, prepared: previous.asset.prepared };
  }
}
