import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ACCESS_ERROR_BRAND } from './error-brand';

export class PasswordBusyError extends Error {
  readonly [ACCESS_ERROR_BRAND] = 'password_busy';
}
export class PasswordPolicyError extends Error {
  readonly [ACCESS_ERROR_BRAND] = 'password_policy';
}
let activeDerivations = 0;
// Worst-case JSON escaping stays below the HTTP handler's 64 KB body cap.
export const PASSWORD_INPUT_MAX_BYTES = 8192;
const CURRENT_HASH = /^scrypt:32768:([a-f0-9]{32}):([a-f0-9]{128})$/;
const IMPORTED_HASH = /^scrypt:imported:([a-f0-9]{32}):([a-f0-9]{128})$/;

function derive(password: string, salt: string, cost: number): Promise<Buffer> {
  // Bound memory and CPU independently of attacker-controlled account names.
  if (activeDerivations >= 4) return Promise.reject(new PasswordBusyError('Password verification is busy'));
  activeDerivations++;
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  }).finally(() => {
    activeDerivations--;
  });
}
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 1_024)
    throw new PasswordPolicyError('Password must contain at least 12 characters and at most 1024 bytes');
  return hashConfiguredPassword(password);
}

/** Hash a caller-validated local configuration value outside the HTTP password policy. */
export async function hashConfiguredPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password) > PASSWORD_INPUT_MAX_BYTES)
    throw new PasswordPolicyError(
      `Existing password exceeds the supported ${PASSWORD_INPUT_MAX_BYTES} UTF-8 bytes`,
    );
  const salt = randomBytes(16).toString('hex');
  return `scrypt:32768:${salt}:${(await derive(password, salt, 32768)).toString('hex')}`;
}

/** Mark an unversioned scrypt record for bounded verification and immediate rewrite. */
export function importPasswordHash(encoded: string): string {
  const match = /^([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded);
  if (!match?.[1] || !match[2]) throw new PasswordPolicyError('Invalid imported password hash');
  return `scrypt:imported:${match[1]}:${match[2]}`;
}

export function passwordHashNeedsUpgrade(encoded: string): boolean {
  return IMPORTED_HASH.test(encoded);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password) > PASSWORD_INPUT_MAX_BYTES) return false;
  const current = CURRENT_HASH.exec(encoded);
  const imported = current ? null : IMPORTED_HASH.exec(encoded);
  const match = current ?? imported;
  if (!match?.[1] || !match[2]) return false;
  const expected = Buffer.from(match[2], 'hex');
  for (const cost of imported ? [32768, 16384] : [32768]) {
    if (timingSafeEqual(await derive(password, match[1], cost), expected)) return true;
  }
  return false;
}
