import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { LocalStorageCleanup } from '../cleanup/backends/local-cleanup';
import { syncDirectory } from './durability';

const identity = z
  .object({
    root: z.string().min(1),
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    binding: z.string().min(1),
  })
  .strict();
export const executionWorkspacePlanSchema = z
  .object({
    locationId: z.uuid(),
    executionId: z.uuid(),
    root: identity,
  })
  .strict();
export const executionWorkspaceSchema = executionWorkspacePlanSchema
  .extend({
    directory: identity,
  })
  .strict()
  .refine((value) => value.directory.root === join(value.root.root, `execution-${value.executionId}`), {
    message: 'Execution workspace directory identity mismatch',
  });
export type ExecutionWorkspacePlan = z.infer<typeof executionWorkspacePlanSchema>;
export type ExecutionWorkspace = z.infer<typeof executionWorkspaceSchema>;

/** Persist this intent before creating a directory. Location IDs identify an operator-managed filesystem. */
export async function planExecutionWorkspace(
  root: string,
  locationId: string,
  executionId: string,
): Promise<ExecutionWorkspacePlan> {
  return executionWorkspacePlanSchema.parse({
    locationId,
    executionId,
    root: (await LocalStorageCleanup.capture(root)).identity,
  });
}

function workspacePath(plan: ExecutionWorkspacePlan) {
  return join(plan.root.root, `execution-${plan.executionId}`);
}

/** Existing directories conflict. Persist the returned identity before starting any child work. */
export async function createExecutionWorkspace(input: ExecutionWorkspacePlan): Promise<ExecutionWorkspace> {
  const plan = executionWorkspacePlanSchema.parse(input);
  await LocalStorageCleanup.restore(plan.root);
  const path = workspacePath(plan);
  await mkdir(path, { mode: 0o700 });
  // Any error leaves the persisted intent available for recovery. Never remove an unverified path.
  const directory = (await LocalStorageCleanup.capture(path)).identity;
  if (directory.root !== path) throw new Error('Execution workspace path changed during creation');
  await LocalStorageCleanup.restore(plan.root);
  syncDirectory(plan.root.root);
  return { ...plan, directory };
}

/**
 * Recover only an admitted intent whose directory identity was never attached.
 * The caller must first confirm termination of the exact executor and all its I/O.
 * An already attached identity must be used directly, never recaptured through this path.
 */
export async function recoverExecutionWorkspace(
  input: ExecutionWorkspacePlan,
  locationId: string,
): Promise<ExecutionWorkspace | null> {
  const plan = executionWorkspacePlanSchema.parse(input);
  if (z.uuid().parse(locationId) !== plan.locationId)
    throw new Error('Execution workspace belongs to another location');
  await LocalStorageCleanup.restore(plan.root);
  const path = workspacePath(plan);
  let info;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    syncDirectory(plan.root.root);
    await LocalStorageCleanup.restore(plan.root);
    return null;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Execution workspace is not a regular directory');
  const directory = (await LocalStorageCleanup.capture(path)).identity;
  if (
    directory.root !== path ||
    directory.device !== String(info.dev) ||
    directory.inode !== String(info.ino)
  )
    throw new Error('Execution workspace changed during recovery');
  await LocalStorageCleanup.restore(plan.root);
  return { ...plan, directory };
}

/**
 * Caller must first establish that the exact executor and all its owned I/O have stopped.
 * Neither a missing directory nor successful removal establishes process termination.
 * Trusted local filesystem writers are required, as for LocalStorageCleanup.
 */
export async function removeExecutionWorkspace(input: ExecutionWorkspace, locationId: string): Promise<void> {
  const workspace = executionWorkspaceSchema.parse(input);
  if (z.uuid().parse(locationId) !== workspace.locationId)
    throw new Error('Execution workspace belongs to another location');
  const path = workspacePath(workspace);
  if (workspace.directory.root !== path) throw new Error('Execution workspace directory identity mismatch');
  await LocalStorageCleanup.restore(workspace.root);
  try {
    await lstat(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    syncDirectory(workspace.root.root);
    await LocalStorageCleanup.restore(workspace.root);
    return;
  }
  await LocalStorageCleanup.restore(workspace.directory);
  await rm(path, { recursive: true });
  syncDirectory(workspace.root.root);
  await LocalStorageCleanup.restore(workspace.root);
}
