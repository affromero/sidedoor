import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { LocalStorageCleanup, type LocalCleanupIdentity } from './local-cleanup';
import { withFileLock } from './lock';
import { syncDirectory } from './durability';
import { StorageReadCleanupError } from './owned-copy';

const locationSchema = z
  .object({
    version: z.literal(1),
    locationId: z.uuid(),
    root: z.object({ root: z.string(), device: z.string(), inode: z.string(), binding: z.string() }).strict(),
  })
  .strict();
export interface ExecutionLocation {
  locationId: string;
  root: Readonly<LocalCleanupIdentity>;
}

/**
 * Initialize only a newly created private root. Existing roots require their valid
 * inode-bound marker, including after crashes. Trusted filesystem writers required.
 * Initialization is explicit; reads never recreate missing roots or markers.
 */
export async function openExecutionLocation(
  input: string,
  options: { create?: boolean; signal?: AbortSignal } = {},
): Promise<ExecutionLocation> {
  const requested = resolve(input);
  const { create = false, signal } = options;
  signal?.throwIfAborted();
  const parent = await LocalStorageCleanup.capture(dirname(requested));
  const path = join(parent.identity.root, basename(requested));
  return withFileLock(
    `${path}.guard`,
    async () => {
      await LocalStorageCleanup.restore(parent.identity);
      signal?.throwIfAborted();
      let created = false;
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700)
        throw new Error('Execution location must be a private regular directory');
      const root = (await LocalStorageCleanup.capture(path)).identity;
      const marker = join(path, 'location.json');
      const file = await open(
        marker,
        (created ? constants.O_RDWR | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      let result: ExecutionLocation | undefined;
      let failure: { error: unknown } | undefined;
      try {
        if (created) {
          await file.writeFile(JSON.stringify({ version: 1, locationId: randomUUID(), root }));
          await file.sync();
          syncDirectory(path);
          syncDirectory(parent.identity.root);
        }
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 4096)
          throw new Error('Execution location marker must be a private bounded regular file');
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error('Execution location marker changed while reading');
          offset += bytesRead;
        }
        const location = locationSchema.parse(JSON.parse(bytes.toString('utf8')));
        await LocalStorageCleanup.restore(location.root);
        if (
          location.root.root !== root.root ||
          location.root.device !== root.device ||
          location.root.inode !== root.inode ||
          location.root.binding !== root.binding
        )
          throw new Error('Execution location marker belongs to another root');
        await LocalStorageCleanup.restore(parent.identity);
        signal?.throwIfAborted();
        result = { locationId: location.locationId, root };
      } catch (error) {
        failure = { error };
      }
      try {
        await file.close();
      } catch (error) {
        const cleanup = new StorageReadCleanupError({ cause: error });
        if (failure)
          throw new AggregateError([failure.error, cleanup], 'Execution location read and cleanup failed', {
            cause: error,
          });
        throw cleanup;
      }
      if (failure) throw failure.error;
      return result!;
    },
    { signal },
  );
}
