import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalStorageCleanup, type LocalCleanupIdentity } from './local-cleanup';
import { normalizeStorageReference } from './references';
import { syncDirectory } from './durability';

export class LocalStorageWriteError extends Error {
  constructor(
    readonly created: boolean,
    cause: unknown,
  ) {
    super(
      created ? 'Storage write failed after file creation' : 'Storage write failed before file creation',
      {
        cause,
      },
    );
    this.name = 'LocalStorageWriteError';
  }
}

/**
 * Immutable writes in application-owned directories with trusted filesystem writers.
 * Callers persist intents for every erasure scope before I/O. Cleanup tombstones
 * and drains those scopes before deleting; keys must never be reused or adopted unfenced.
 * Failures retain partial files. They never imply permission to restart an operation.
 * The caller owns a supplied stream until the pipeline starts, including destroying
 * it if validation or exclusive creation fails. Pipeline failures destroy the input.
 */
export class LocalStorageWriter {
  private constructor(readonly identity: Readonly<LocalCleanupIdentity>) {}

  static async restore(identity: LocalCleanupIdentity): Promise<LocalStorageWriter> {
    return new LocalStorageWriter((await LocalStorageCleanup.restore(identity)).identity);
  }

  private async verifyRoot(): Promise<void> {
    await LocalStorageCleanup.restore(this.identity);
  }

  private async parentFor(key: string): Promise<string> {
    if (normalizeStorageReference({ kind: 'local', root: this.identity.root }, key) !== key)
      throw new Error('Writing requires an exact storage key');
    await this.verifyRoot();
    let parent = this.identity.root;
    for (const part of key.split('/').slice(0, -1)) {
      const directory = join(parent, part);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error('Storage key parent is not a regular directory');
      // Flush even an existing entry: another admitted writer may have just created it.
      syncDirectory(parent);
      parent = directory;
    }
    await this.verifyRoot();
    return parent;
  }

  async writeImmutable(key: string, body: Uint8Array | Readable, signal?: AbortSignal): Promise<void> {
    let created = false;
    try {
      signal?.throwIfAborted();
      const parent = await this.parentFor(key);
      signal?.throwIfAborted();
      const target = join(this.identity.root, key);
      if (dirname(target) !== parent) throw new Error('Storage key parent changed');
      const file = await open(target, 'wx', 0o600);
      created = true;
      try {
        if (body instanceof Readable) {
          await pipeline(
            body,
            async (source: AsyncIterable<Uint8Array | string>) => {
              for await (const chunk of source) await file.writeFile(chunk, { signal });
            },
            { signal },
          );
        } else {
          await file.writeFile(body, { signal });
        }
        await file.sync();
        syncDirectory(parent);
        await this.verifyRoot();
      } finally {
        await file.close();
      }
    } catch (cause) {
      throw new LocalStorageWriteError(created, cause);
    }
  }
}
