import type { StateStore } from '../storage/index';
import { AccessError } from './service';
import { deviceTokenSchema, principalSchema, type AccessState, type Principal } from './state';

export interface InitialHouseholdDevice {
  hash: string;
  defaultProfileId: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  scopes: readonly string[];
}

/** Initialize household-scoped device hashes without granting individual or owner authority. */
export function initializeHouseholdDevices(
  state: AccessState,
  initialization: string,
  devices: readonly InitialHouseholdDevice[],
  allowedScopes: readonly string[],
): boolean {
  if (!initialization || initialization.length > 200) throw new AccessError('invalid');
  if (state.initializations.includes(initialization)) return false;
  if (state.mode !== 'household') throw new AccessError('conflict');
  const ids = new Set(state.deviceTokens.map((device) => device.id));
  const imported = devices.map((device) => {
    const profile = state.householdProfiles?.find((profile) => profile.id === device.defaultProfileId);
    if (
      !/^[a-f0-9]{64}$/.test(device.hash) ||
      ids.has(device.hash) ||
      !profile ||
      !device.scopes.length ||
      device.scopes.some((scope) => !allowedScopes.includes(scope)) ||
      !device.name.trim() ||
      !Number.isSafeInteger(device.createdAt) ||
      (device.expiresAt !== null &&
        (!Number.isSafeInteger(device.expiresAt) || device.expiresAt <= device.createdAt))
    )
      throw new AccessError('invalid', 'Invalid household device');
    ids.add(device.hash);
    return deviceTokenSchema.parse({
      id: device.hash,
      principalId: null,
      issuerSessionId: `initialize:${initialization}`,
      defaultProfileId: device.defaultProfileId,
      defaultProfileEpoch: profile.epoch,
      epoch: state.householdEpoch,
      scopes: [...new Set(device.scopes)],
      name: device.name,
      createdAt: device.createdAt,
      expiresAt: device.expiresAt,
    });
  });
  state.deviceTokens.push(...imported);
  state.initializations.push(initialization);
  return true;
}

export interface InitialAccess {
  principals: readonly Principal[];
  mode: AccessState['mode'];
  householdPasswordHash?: string | null;
}

/** Local canonical-state initializer. Never accept an initialization snapshot from an HTTP caller. */
export async function initializeAccess(
  store: StateStore<AccessState>,
  initialization: string,
  input: InitialAccess,
): Promise<boolean> {
  if (!initialization || initialization.length > 200) throw new AccessError('invalid');
  const principals = input.principals.map((principal) => principalSchema.parse(principal));
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const principal of principals) {
    if (ids.has(principal.id) || names.has(principal.name)) throw new AccessError('conflict');
    ids.add(principal.id);
    names.add(principal.name);
  }
  for (const encoded of [
    ...principals.map((principal) => principal.passwordHash),
    input.householdPasswordHash,
  ]) {
    if (encoded && !/^scrypt:(?:32768|imported):[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded))
      throw new AccessError('invalid', 'Invalid password hash format');
  }
  return store.transact((state) => {
    if (state.initializations.includes(initialization)) return false;
    if (
      state.principals.length ||
      state.sessions.length ||
      state.passkeys.length ||
      state.householdPasswordHash
    )
      throw new AccessError('conflict');
    state.principals = structuredClone(principals);
    state.mode = input.mode;
    state.householdPasswordHash = input.householdPasswordHash ?? null;
    state.policyEpoch++;
    state.householdEpoch++;
    state.tokens = [];
    state.invitations = [];
    state.deviceTokens = [];
    state.initializations.push(initialization);
    return true;
  });
}
