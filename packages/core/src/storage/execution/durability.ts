import { openSync, fsyncSync, closeSync } from 'node:fs';

/** Flush directory-entry changes before declaring a rename or deletion durable. */
export function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
