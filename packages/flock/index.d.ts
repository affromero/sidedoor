export const constants: { readonly LOCK_SH: number; readonly LOCK_EX: number; readonly LOCK_NB: number };
export function flock(descriptor: number, flags: number): void;
