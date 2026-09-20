import type { z } from 'zod';

/** Deterministic encoding for already validated JSON, including PostgreSQL JSONB round trips. */
export function canonicalJson(value: z.infer<ReturnType<typeof z.json>>): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}
