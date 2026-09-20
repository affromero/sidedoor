import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalStorageCleanup, type LocalCleanupIdentity } from '../cleanup/backends/local-cleanup';
import { validateStorageKey } from '../registry/references';
import { copyOwnedBytesToFile, type StorageCopyContent } from './owned-copy';
export { StorageReadCleanupError } from './owned-copy';

/** Captured roots require trusted filesystem writers. Failed copies may leave partial temporary files. */
export class LocalStorageReader {
  private constructor(readonly identity: Readonly<LocalCleanupIdentity>) {}

  static async restore(identity: LocalCleanupIdentity): Promise<LocalStorageReader> {
    return new LocalStorageReader((await LocalStorageCleanup.restore(identity)).identity);
  }

  async copyToFile(key: string, destination: string, signal?: AbortSignal): Promise<StorageCopyContent> {
    signal?.throwIfAborted();
    validateStorageKey(key);
    const root = await LocalStorageCleanup.restore(this.identity);
    if (!(await root.has(key))) throw new Error('Storage source does not exist');
    const source = join(this.identity.root, key);
    return copyOwnedBytesToFile({
      destination,
      signal,
      openSource: async () => {
        const buffer = Buffer.allocUnsafe(65536);
        const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        let validated = false;
        return {
          close: () => file.close(),
          read: async () => {
            if (!validated) {
              const opened = await file.stat({ bigint: true });
              const current = await lstat(source, { bigint: true });
              if (
                !opened.isFile() ||
                current.isSymbolicLink() ||
                opened.dev !== current.dev ||
                opened.ino !== current.ino
              )
                throw new Error('Storage source changed while opening');
              if (!(await root.has(key))) throw new Error('Storage source disappeared while opening');
              await LocalStorageCleanup.restore(this.identity);
              signal?.throwIfAborted();
              validated = true;
            }
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (bytesRead) return buffer.subarray(0, bytesRead);
            await LocalStorageCleanup.restore(this.identity);
            return null;
          },
        };
      },
    });
  }
}
