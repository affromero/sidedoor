import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { acquireFileLockSync } from './lock';
import { syncDirectory } from './durability';

/**
 * The parent directory must already exist inside trusted application storage.
 * Creation is allowed only while holding the authoritative credential-state
 * transaction and after confirming that it contains no encrypted records.
 * Reads may create the stable lock anchor, but never the key itself.
 */
export function localEncryptionKey(path: string, options: { create: boolean }): Uint8Array {
  if (!statSync(dirname(path)).isDirectory()) throw new Error('Encryption key parent is not a directory');
  const release = acquireFileLockSync(`${path}.guard`, options.create ? 'exclusive' : 'shared');
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(
        path,
        (options.create ? constants.O_RDWR : constants.O_RDONLY) |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
    } catch (error) {
      if (!options.create || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
        throw error;
      descriptor = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, randomBytes(32));
    }
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.size !== 32 || (file.mode & 0o7777) !== 0o600)
      throw new Error('Encryption key must be a regular 32-byte file with mode 0600');
    if (options.create) {
      fsyncSync(descriptor);
      syncDirectory(dirname(path));
    }
    const key = Buffer.alloc(32);
    let offset = 0;
    while (offset < key.length) {
      const bytes = readSync(descriptor, key, offset, key.length - offset, offset);
      if (!bytes) throw new Error('Encryption key changed while reading');
      offset += bytes;
    }
    return key;
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      release();
    }
  }
}
