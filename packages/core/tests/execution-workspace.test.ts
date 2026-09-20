import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  planExecutionWorkspace,
  createExecutionWorkspace,
  recoverExecutionWorkspace,
  removeExecutionWorkspace,
} from '../src/storage/execution-workspace';

describe('execution workspace ownership', () => {
  let root: string;
  const locationId = randomUUID();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidedoor-workspace-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('creates a private execution directory and removes its complete contents', async () => {
    const plan = await planExecutionWorkspace(root, locationId, randomUUID());
    const workspace = await createExecutionWorkspace(plan);
    expect((await lstat(workspace.directory.root)).mode & 0o777).toBe(0o700);
    await mkdir(join(workspace.directory.root, 'nested'));
    await writeFile(join(workspace.directory.root, 'nested', 'audio'), 'private audio');
    await removeExecutionWorkspace(workspace, locationId);
    await expect(lstat(workspace.directory.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await removeExecutionWorkspace(workspace, locationId);
  });
  it('rejects an existing directory without adopting or deleting its contents', async () => {
    const plan = await planExecutionWorkspace(root, locationId, randomUUID());
    const workspace = await createExecutionWorkspace(plan);
    await writeFile(join(workspace.directory.root, 'audio'), 'preserved');
    await expect(createExecutionWorkspace(plan)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(workspace.directory.root, 'audio'), 'utf8')).toBe('preserved');
  });
  it('rejects another executor location without touching the directory', async () => {
    const workspace = await createExecutionWorkspace(
      await planExecutionWorkspace(root, locationId, randomUUID()),
    );
    await expect(removeExecutionWorkspace(workspace, randomUUID())).rejects.toThrow('another location');
    expect((await lstat(workspace.directory.root)).isDirectory()).toBe(true);
  });
  it.each(['directory', 'symlink'])('rejects a replaced workspace (%s)', async (replacement) => {
    const workspace = await createExecutionWorkspace(
      await planExecutionWorkspace(root, locationId, randomUUID()),
    );
    const original = join(root, 'original');
    await rename(workspace.directory.root, original);
    if (replacement === 'directory') await mkdir(workspace.directory.root);
    else await symlink(original, workspace.directory.root);
    await writeFile(join(workspace.directory.root, 'audio'), 'preserved');
    await expect(removeExecutionWorkspace(workspace, locationId)).rejects.toThrow('Storage root changed');
    expect(await readFile(join(workspace.directory.root, 'audio'), 'utf8')).toBe('preserved');
  });
  it('rejects root replacement before creating an execution directory', async () => {
    const parent = join(root, 'owned');
    await mkdir(parent);
    const plan = await planExecutionWorkspace(parent, locationId, randomUUID());
    await rename(parent, join(root, 'original'));
    await mkdir(parent);
    await expect(createExecutionWorkspace(plan)).rejects.toThrow('Storage root changed');
    await expect(lstat(join(parent, `execution-${plan.executionId}`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('recovers a directory created before its identity was attached', async () => {
    const plan = await planExecutionWorkspace(root, locationId, randomUUID());
    const created = await createExecutionWorkspace(plan);
    await writeFile(join(created.directory.root, 'audio'), 'private audio');
    const recovered = await recoverExecutionWorkspace(plan, locationId);
    expect(recovered).toEqual(created);
    await removeExecutionWorkspace(recovered!, locationId);
    expect(await recoverExecutionWorkspace(plan, locationId)).toBeNull();
    await expect(recoverExecutionWorkspace(created, locationId)).rejects.toThrow();
  });
  it('rejects symbolic links and another location during intent recovery', async () => {
    const plan = await planExecutionWorkspace(root, locationId, randomUUID());
    const external = join(root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'audio'), 'preserved');
    await symlink(external, join(root, `execution-${plan.executionId}`));
    await expect(recoverExecutionWorkspace(plan, randomUUID())).rejects.toThrow('another location');
    await expect(recoverExecutionWorkspace(plan, locationId)).rejects.toThrow('not a regular directory');
    expect(await readFile(join(external, 'audio'), 'utf8')).toBe('preserved');
  });
});
