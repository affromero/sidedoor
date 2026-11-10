import { afterEach, describe, expect, it } from 'vitest';
import { selectRelocationComponent } from '../../../../src/storage/local/relocation/component';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

async function allPages<Item>(
  read: (cursor: string | null) => Promise<{ items: Item[]; cursor: string | null }>,
) {
  const items: Item[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    if (cursor && page.cursor && page.cursor <= cursor) throw new Error('Inventory cursor did not advance');
    cursor = page.cursor;
  } while (cursor !== null);
  return items;
}

async function sharedHistory(padding = 0) {
  const item = fixture();
  for (let index = 0; index < padding; index++) {
    const { evidence } = await item.pair();
    await item.transaction(() => item.relocations.record(evidence));
  }
  const consumers = ['owner:avatar', 'other:avatar'];
  const scopes = [
    { subjectId: 'profile:owner', generation: 1 },
    { subjectId: 'profile:other', generation: 2 },
  ];
  const source = await item.asset(consumers, null, scopes);
  const middle = await item.asset(consumers, source.prepared.reference, scopes);
  await item.transaction(() => item.relocations.record(item.proof(source, middle, consumers)));
  const terminal = await item.asset(consumers, middle.prepared.reference, scopes);
  await item.transaction(() => item.relocations.record(item.proof(middle, terminal, consumers)));
  const unrelated = await item.asset(['owner:avatar']);
  const inventory = async () => ({
    namespace: 'test',
    assets: await allPages(async (cursor) => {
      const page = await item.registry.listAssets(cursor);
      return { items: page.assets, cursor: page.cursor };
    }),
    allocations: await allPages(async (cursor) => {
      const page = await item.registry.listAllocations(cursor);
      return { items: page.allocations, cursor: page.cursor };
    }),
    retirements: await allPages(async (cursor) => {
      const page = await item.registry.listRetirements(cursor);
      return { items: page.retirements, cursor: page.cursor };
    }),
    receipts: await allPages(async (cursor) => {
      const page = await item.relocations.listAll(cursor);
      return { items: page.receipts, cursor: page.cursor };
    }),
    seedAssetIds: [middle.id],
    maxAssets: 10,
    maxInventoryEntries: 5000,
    maxInventoryUnits: 1_000_000,
  });
  return { item, source, middle, terminal, unrelated, scopes, inventory };
}

describe('relocation component selection', () => {
  it('finds both hops and excludes an unrelated asset with the same consumer', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const before = structuredClone(input);
    const component = selectRelocationComponent(input);
    expect(input).toEqual(before);
    expect(new Set(component.assets.map((asset) => asset.id))).toEqual(
      new Set([fixture.source.id, fixture.middle.id, fixture.terminal.id]),
    );
    expect(component.assets.some((asset) => asset.id === fixture.unrelated.id)).toBe(false);
    expect(component.receipts).toHaveLength(2);
    expect(component.retirements).toHaveLength(4);
    expect(component.outsideAllocations).toEqual([]);
    expect(
      selectRelocationComponent({
        ...input,
        assets: [...input.assets].reverse(),
        allocations: [...input.allocations].reverse(),
        retirements: [...input.retirements].reverse(),
        receipts: [...input.receipts].reverse(),
      }),
    ).toEqual(component);
  });

  it('reports an ordinary outside replacement and its unresolved retirement', async () => {
    const fixture = await sharedHistory();
    const replacement = await fixture.item.asset(
      ['owner:avatar'],
      fixture.middle.prepared.reference,
      fixture.scopes,
    );
    const component = selectRelocationComponent(await fixture.inventory());
    expect(component.assets.some((asset) => asset.id === replacement.id)).toBe(false);
    expect(component.outsideAllocations.map((allocation) => allocation.assetId)).toContain(replacement.id);
    expect(
      component.retirements.some(
        (retirement) =>
          retirement.operationId === replacement.prepared.operationId && retirement.status === 'unresolved',
      ),
    ).toBe(true);
  });

  it('reports an outside replacement named by related retirement attribution', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const retirement = input.retirements.find((item) => item.attribution?.assetId === fixture.middle.id);
    if (!retirement) throw new Error('Missing middle retirement');
    retirement.previousReference = 'https://media.example/different';
    retirement.replacementAssetId = fixture.unrelated.id;
    const component = selectRelocationComponent(input);
    expect(component.outsideAllocations.map((item) => item.assetId)).toContain(fixture.unrelated.id);
    expect(component.assets.some((asset) => asset.id === fixture.unrelated.id)).toBe(false);
    const missing = selectRelocationComponent({
      ...input,
      assets: input.assets.filter((asset) => asset.id !== fixture.unrelated.id),
    });
    expect(missing.outsideAllocations.map((item) => item.assetId)).toContain(fixture.unrelated.id);
    expect(missing.missingOutsideAssetIds).toContain(fixture.unrelated.id);
  });

  it('includes every retirement belonging to a related outside allocation', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const allocation = input.allocations.find((item) => item.assetId === fixture.unrelated.id);
    const template = input.retirements[0];
    if (!allocation || !template) throw new Error('Missing outside evidence');
    allocation.claims = [
      { consumer: 'owner:avatar', previousReference: fixture.middle.prepared.reference },
      { consumer: 'second:avatar', previousReference: 'https://media.example/elsewhere' },
    ];
    input.retirements.push({
      ...template,
      operationId: allocation.operationId,
      consumer: 'second:avatar',
      previousReference: 'https://media.example/elsewhere',
      replacementAssetId: allocation.assetId,
      attribution: null,
      status: 'unresolved',
    });
    const component = selectRelocationComponent(input);
    expect(component.outsideAllocations.map((item) => item.assetId)).toContain(allocation.assetId);
    expect(
      component.retirements.some(
        (item) => item.operationId === allocation.operationId && item.consumer === 'second:avatar',
      ),
    ).toBe(true);
  });

  it('includes all retirements for a selected allocation operation', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const template = input.retirements[0];
    if (!template) throw new Error('Missing retirement template');
    input.retirements.push({
      ...template,
      operationId: fixture.source.prepared.operationId,
      consumer: 'second:avatar',
      previousReference: 'https://media.example/elsewhere',
      replacementAssetId: null,
      attribution: null,
      status: 'unresolved',
    });
    expect(
      selectRelocationComponent(input).retirements.some(
        (item) =>
          item.operationId === fixture.source.prepared.operationId && item.consumer === 'second:avatar',
      ),
    ).toBe(true);
  });

  it('reports an outside predecessor named by a selected allocation retirement', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const template = input.retirements[0];
    if (!template) throw new Error('Missing retirement template');
    input.retirements.push({
      ...template,
      operationId: fixture.source.prepared.operationId,
      consumer: 'second:avatar',
      previousReference: fixture.unrelated.prepared.reference,
      replacementAssetId: fixture.source.id,
      attribution: { assetId: fixture.unrelated.id, prepared: fixture.unrelated.prepared },
      status: 'pending',
    });
    const component = selectRelocationComponent(input);
    expect(component.outsideAllocations.map((item) => item.assetId)).toContain(fixture.unrelated.id);
    expect(component.outsideAssets.map((item) => item.id)).toContain(fixture.unrelated.id);
  });

  it('finds a claimed predecessor even when its retirement is missing', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const origin = input.allocations.find((item) => item.assetId === fixture.source.id);
    if (!origin) throw new Error('Missing origin allocation');
    const claim = origin.claims.find((item) => item.consumer === 'owner:avatar');
    if (!claim) throw new Error('Missing origin claim');
    claim.previousReference = fixture.unrelated.prepared.reference;
    const component = selectRelocationComponent(input);
    expect(component.outsideAssets.map((item) => item.id)).toContain(fixture.unrelated.id);
    expect(component.missingRetirementClaims).toContainEqual({
      operationId: origin.operationId,
      consumer: claim.consumer,
    });
  });

  it('reports another allocation sharing a selected operation', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const outside = input.allocations.find((item) => item.assetId === fixture.unrelated.id);
    const asset = input.assets.find((item) => item.id === fixture.unrelated.id);
    if (!outside || !asset) throw new Error('Missing outside allocation');
    outside.operationId = fixture.source.prepared.operationId;
    asset.prepared.operationId = outside.operationId;
    const component = selectRelocationComponent(input);
    expect(component.outsideAssets.map((item) => item.id)).toContain(asset.id);
  });

  it('rejects a self-reference identifiable from retained attribution after asset loss', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const outside = input.allocations.find((item) => item.assetId === fixture.unrelated.id);
    const template = input.retirements[0];
    if (!outside || !template) throw new Error('Missing outside evidence');
    outside.claims[0]!.previousReference = fixture.unrelated.prepared.reference;
    input.retirements.push({
      ...template,
      operationId: fixture.source.prepared.operationId,
      consumer: 'second:avatar',
      previousReference: fixture.unrelated.prepared.reference,
      replacementAssetId: fixture.source.id,
      attribution: { assetId: fixture.unrelated.id, prepared: fixture.unrelated.prepared },
      status: 'pending',
    });
    expect(() =>
      selectRelocationComponent({
        ...input,
        assets: input.assets.filter((asset) => asset.id !== fixture.unrelated.id),
      }),
    ).toThrow('self-reference needs independent verification');
  });

  it('follows exact references through multiple outside replacements', async () => {
    const fixture = await sharedHistory();
    const first = await fixture.item.asset(
      ['owner:avatar'],
      fixture.middle.prepared.reference,
      fixture.scopes,
    );
    const second = await fixture.item.asset(['owner:avatar'], first.prepared.reference, fixture.scopes);
    const component = selectRelocationComponent(await fixture.inventory());
    expect(new Set(component.outsideAssets.map((item) => item.id))).toEqual(new Set([first.id, second.id]));
    expect(component.retirements.some((item) => item.operationId === second.prepared.operationId)).toBe(true);
  });

  it('follows receipt edges even when an outside asset row is missing', async () => {
    const fixture = await sharedHistory();
    const first = await fixture.item.asset(
      ['owner:avatar'],
      fixture.middle.prepared.reference,
      fixture.scopes,
    );
    const second = await fixture.item.asset(['owner:avatar'], first.prepared.reference, fixture.scopes);
    await fixture.item.transaction(() => fixture.item.relocations.record(fixture.item.proof(first, second)));
    const input = await fixture.inventory();
    const component = selectRelocationComponent({
      ...input,
      assets: input.assets.filter((asset) => asset.id !== first.id),
    });
    expect(component.missingOutsideAssetIds).toContain(first.id);
    expect(
      component.outsideReceipts.some((receipt) => receipt.operationId === second.prepared.operationId),
    ).toBe(true);
    expect(component.outsideAssets.map((asset) => asset.id)).toContain(second.id);
  });

  it('follows shared unknown references and reports missing retirement claims', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const origin = input.allocations.find((item) => item.assetId === fixture.source.id);
    const outside = input.allocations.find((item) => item.assetId === fixture.unrelated.id);
    if (!origin || !outside) throw new Error('Missing allocations');
    const missingReference = 'https://media.example/unknown';
    origin.claims[0]!.previousReference = missingReference;
    outside.claims[0]!.previousReference = missingReference;
    const component = selectRelocationComponent(input);
    expect(component.unresolvedPreviousReferences).toContain(missingReference);
    expect(component.outsideAssets.map((asset) => asset.id)).toContain(fixture.unrelated.id);
    expect(component.missingRetirementClaims).toContainEqual({
      operationId: outside.operationId,
      consumer: outside.claims[0]!.consumer,
    });
  });

  it('rejects a self-referencing allocation without guessing its history', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const allocation = input.allocations.find((item) => item.assetId === fixture.source.id);
    if (!allocation) throw new Error('Missing allocation');
    allocation.claims[0]!.previousReference = fixture.source.prepared.reference;
    expect(() => selectRelocationComponent(input)).toThrow('self-reference needs independent verification');
  });

  it('terminates when outside replacement evidence contains a cycle', async () => {
    const fixture = await sharedHistory();
    const other = await fixture.item.asset(['owner:avatar']);
    const input = await fixture.inventory();
    const first = input.allocations.find((item) => item.assetId === fixture.unrelated.id);
    const second = input.allocations.find((item) => item.assetId === other.id);
    const template = input.retirements[0];
    if (!first || !second || !template) throw new Error('Missing outside evidence');
    first.claims[0]!.previousReference = fixture.middle.prepared.reference;
    for (const [allocation, replacementAssetId] of [
      [first, second.assetId],
      [second, first.assetId],
    ] as const)
      input.retirements.push({
        ...template,
        operationId: allocation.operationId,
        consumer: 'owner:avatar',
        previousReference: 'https://media.example/elsewhere',
        replacementAssetId,
        attribution: null,
        status: 'unresolved',
      });
    const component = selectRelocationComponent(input);
    expect(new Set(component.outsideAllocations.map((item) => item.assetId))).toEqual(
      new Set([first.assetId, second.assetId]),
    );
    expect(component.missingOutsideAssetIds).toEqual([]);
  });

  it('finds connected receipts beyond the first inventory page', async () => {
    const fixture = await sharedHistory(101);
    const input = await fixture.inventory();
    const last = [...input.receipts]
      .sort((left, right) => left.operationId.localeCompare(right.operationId))
      .at(-1);
    if (!last) throw new Error('Missing receipt');
    expect(
      (await fixture.item.relocations.listAll()).receipts.some(
        (receipt) => receipt.operationId === last.operationId,
      ),
    ).toBe(false);
    const component = selectRelocationComponent({ ...input, seedAssetIds: [last.sourceAssetId] });
    expect(component.receipts.some((receipt) => receipt.operationId === last.operationId)).toBe(true);
  });

  it('rejects conflicting claims and large inventories before graph traversal', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    const duplicate = structuredClone(input);
    const allocation = duplicate.allocations[0]!;
    allocation.claims.push({
      ...allocation.claims[0]!,
      previousReference: 'https://media.example/different',
    });
    expect(() => selectRelocationComponent(duplicate)).toThrow('Storage consumers must be distinct');
    const manyReceipts = Array.from({ length: 1000 }, (_, index) => ({
      ...input.receipts[0]!,
      operationId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    }));
    expect(() =>
      selectRelocationComponent({ ...input, receipts: manyReceipts, maxAssets: 1, maxInventoryEntries: 100 }),
    ).toThrow('inventory exceeds its entry limit');
    const oversized = structuredClone(input);
    oversized.assets[0]!.prepared.reference = 'x'.repeat(10_000);
    expect(() => selectRelocationComponent({ ...oversized, maxInventoryUnits: 1000 })).toThrow(
      'inventory exceeds its data limit',
    );
    const inherited = structuredClone(input);
    Object.setPrototypeOf(inherited.assets[0], { extra: true });
    expect(() => selectRelocationComponent(inherited)).toThrow('inventory is malformed');
    const customIterator = structuredClone(input);
    Object.defineProperty(customIterator.receipts, Symbol.iterator, {
      value: function* () {
        while (true) yield null;
      },
    });
    expect(() => selectRelocationComponent(customIterator)).toThrow('inventory is malformed');
    const topLevelGetter = structuredClone(input);
    let invoked = false;
    Object.defineProperty(topLevelGetter, 'assets', {
      enumerable: true,
      get() {
        invoked = true;
        return [];
      },
    });
    expect(() => selectRelocationComponent(topLevelGetter)).toThrow('inventory is malformed');
    expect(invoked).toBe(false);
    const nestedGetter = structuredClone(input);
    Object.defineProperty(nestedGetter.assets[0]!.prepared, 'reference', {
      enumerable: false,
      get() {
        invoked = true;
        return '';
      },
    });
    expect(() => selectRelocationComponent(nestedGetter)).toThrow('inventory is malformed');
    expect(invoked).toBe(false);
  });

  it('rejects a missing endpoint, duplicate identity, or a component beyond its limit', async () => {
    const fixture = await sharedHistory();
    const input = await fixture.inventory();
    expect(() =>
      selectRelocationComponent({
        ...input,
        assets: input.assets.filter((asset) => asset.id !== fixture.terminal.id),
      }),
    ).toThrow('asset or allocation is missing');
    expect(() =>
      selectRelocationComponent({ ...input, allocations: [...input.allocations, input.allocations[0]!] }),
    ).toThrow('allocation identity is invalid or duplicated');
    expect(() => selectRelocationComponent({ ...input, maxAssets: 2 })).toThrow(
      'component exceeds its asset limit',
    );
  });
});
