import { lstat, opendir, realpath, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { normalizeStorageReference, storageBackendBinding } from './references';
import { syncDirectory } from './durability';

export interface LocalCleanupIdentity {
  root: string;
  device: string;
  inode: string;
  binding: string;
}

/**
 * For application-owned directories with trusted filesystem writers. Checks reject
 * symlinks, but cannot prevent a hostile local process racing filesystem operations.
 */
export class LocalStorageCleanup {
  private activeListings = 0;
  private activeDeletions = 0;
  private constructor(readonly identity: Readonly<LocalCleanupIdentity>) {}

  static async capture(root: string): Promise<LocalStorageCleanup> {
    const resolved = await realpath(root);
    const info = await lstat(resolved, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Storage root is not a directory');
    return new LocalStorageCleanup(
      Object.freeze({
        root: resolved,
        device: String(info.dev),
        inode: String(info.ino),
        binding: storageBackendBinding({ kind: 'local', root: resolved }),
      }),
    );
  }

  /** Reopen an outbox location only when the original directory still exists. */
  static async restore(identity: LocalCleanupIdentity): Promise<LocalStorageCleanup> {
    const current = await LocalStorageCleanup.capture(identity.root);
    if (
      current.identity.root !== identity.root ||
      current.identity.device !== identity.device ||
      current.identity.inode !== identity.inode ||
      current.identity.binding !== identity.binding
    )
      throw new Error('Storage root changed since cleanup was scheduled');
    return current;
  }

  private async verifyRoot(): Promise<void> {
    const info = await lstat(this.identity.root, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      String(info.dev) !== this.identity.device ||
      String(info.ino) !== this.identity.inode
    )
      throw new Error('Storage root changed since cleanup was scheduled');
  }

  private async verifyAbsence(parent: string): Promise<void> {
    await this.verifyRoot();
    if ((await realpath(parent)) !== parent) throw new Error('Storage path changed during cleanup');
    syncDirectory(parent);
    await this.verifyRoot();
  }

  /** Stream exact keys under an owned directory prefix without following links. */
  async *list(prefix: string): AsyncGenerator<string> {
    if (this.activeDeletions) throw new Error('Finish deleting before collecting another cleanup manifest');
    this.activeListings++;
    try {
      yield* this.listExact(prefix);
    } finally {
      this.activeListings--;
    }
  }

  private async *listExact(prefix: string): AsyncGenerator<string> {
    if (!prefix.endsWith('/')) throw new Error('Cleanup listing requires a directory prefix');
    const key = prefix.slice(0, -1);
    const normalized = normalizeStorageReference({ kind: 'local', root: this.identity.root }, key);
    if (normalized !== key) throw new Error('Cleanup requires an exact storage prefix');
    await this.verifyRoot();
    let directory = this.identity.root;
    for (const part of key.split('/')) {
      const existingParent = directory;
      directory = join(directory, part);
      let info;
      try {
        info = await lstat(directory);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await this.verifyAbsence(existingParent);
          return;
        }
        throw error;
      }
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Cleanup prefix is not a regular directory');
    }
    yield* this.walk(directory, prefix, 0);
  }

  private async *walk(directory: string, prefix: string, depth: number): AsyncGenerator<string> {
    if (depth > 128) throw new Error('Storage directory nesting exceeds the cleanup limit');
    await this.verifyRoot();
    if ((await realpath(directory)) !== directory) throw new Error('Storage path changed during cleanup');
    for await (const entry of await opendir(directory)) {
      if (entry.isSymbolicLink()) throw new Error('Cleanup refuses symbolic links');
      if (entry.isDirectory()) {
        yield* this.walk(join(directory, entry.name), `${prefix}${entry.name}/`, depth + 1);
      } else if (entry.isFile()) {
        yield `${prefix}${entry.name}`;
      } else throw new Error('Cleanup target is not a regular file');
    }
  }

  /** Verify one exact regular file, including root-level references. */
  async has(key: string): Promise<boolean> {
    if (this.activeDeletions) throw new Error('Finish deleting before collecting another cleanup manifest');
    this.activeListings++;
    try {
      if (normalizeStorageReference({ kind: 'local', root: this.identity.root }, key) !== key)
        throw new Error('Cleanup requires an exact storage key');
      await this.verifyRoot();
      const parts = key.split('/');
      let target = this.identity.root;
      for (const [index, part] of parts.entries()) {
        const existingParent = target;
        target = join(target, part);
        let info;
        try {
          info = await lstat(target);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            await this.verifyAbsence(existingParent);
            return false;
          }
          throw error;
        }
        if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()))
          throw new Error('Cleanup target is not a regular file');
      }
      if ((await realpath(target)) !== target) throw new Error('Storage path changed during cleanup');
      await this.verifyRoot();
      return true;
    } finally {
      this.activeListings--;
    }
  }

  /** Exact keys only. Missing objects are already deleted; other failures remain visible. */
  async delete(key: string): Promise<void> {
    if (this.activeListings) throw new Error('Finish collecting the cleanup manifest before deleting');
    this.activeDeletions++;
    try {
      await this.deleteExact(key);
    } finally {
      this.activeDeletions--;
    }
  }

  private async deleteExact(key: string): Promise<void> {
    const normalized = normalizeStorageReference({ kind: 'local', root: this.identity.root }, key);
    if (normalized !== key) throw new Error('Cleanup requires an exact storage key');
    await this.verifyRoot();
    const parts = key.split('/');
    let target = this.identity.root;
    for (const [index, part] of parts.entries()) {
      const existingParent = target;
      target = join(target, part);
      let info;
      try {
        info = await lstat(target);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await this.verifyAbsence(existingParent);
          return;
        }
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('Cleanup refuses symbolic links');
      if (index < parts.length - 1) {
        if (!info.isDirectory()) throw new Error('Storage key parent is not a directory');
      } else if (!info.isFile()) throw new Error('Cleanup target is not a regular file');
    }
    const parent = target.slice(0, target.lastIndexOf(sep));
    if ((await realpath(parent)) !== parent) throw new Error('Storage path changed during cleanup');
    await this.verifyRoot();
    try {
      await unlink(target);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    syncDirectory(parent);
  }
}
