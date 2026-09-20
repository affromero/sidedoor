export const ACCESS_ERROR_BRAND = Symbol.for('thesidedoor.access.error');

export function hasAccessErrorBrand(
  error: unknown,
  kind: 'access' | 'password_policy' | 'password_busy',
): boolean {
  return (
    error instanceof Error &&
    (error as Error & { [ACCESS_ERROR_BRAND]?: unknown })[ACCESS_ERROR_BRAND] === kind
  );
}
