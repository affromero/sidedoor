import { randomUUID } from 'node:crypto';
import { AccessError, type AccessService } from '../core/service';
import type { DeviceService } from '../admission/devices';
import type { AccessState } from '../core/state';
import { createPrincipalFromState, removePrincipalFromState } from './principals';

export type ProfileManagerCredential = { kind: 'session' | 'device'; token: string };
export interface ProfileManagementOptions {
  allowHouseholdManagement?: boolean;
  devices?: DeviceService;
  requiredDeviceScopes?: readonly string[];
  ownerDeviceScope?: string;
  minimumProfiles?: number;
}
export interface PreparedProfileCreation {
  readonly id: string;
  readonly name: string;
  apply(state: AccessState, credential: ProfileManagerCredential): string;
}
export interface PreparedProfileUpdate {
  readonly id: string;
  readonly name: string | undefined;
  apply(state: AccessState, credential: ProfileManagerCredential): void;
}
export interface PreparedProfileRemoval {
  readonly id: string;
  apply(state: AccessState, credential: ProfileManagerCredential): void;
}

/** Explicit household labels and account login names have separate lifecycles. */
export class HouseholdProfileManagement {
  constructor(
    private readonly access: AccessService,
    private readonly options: ProfileManagementOptions = {},
  ) {
    if (!Number.isSafeInteger(options.minimumProfiles ?? 0) || (options.minimumProfiles ?? 0) < 0)
      throw new AccessError('invalid');
  }

  private authorize(state: AccessState, credential: ProfileManagerCredential): boolean {
    if (state.mode !== 'household' || state.householdProfiles === undefined)
      throw new AccessError('forbidden');
    if (credential.kind === 'session') {
      const { principal } = this.access.sessionFromState(state, credential.token);
      if (principal?.role === 'owner') return true;
      if (principal === null && this.options.allowHouseholdManagement) return false;
      throw new AccessError('forbidden');
    }
    if (!this.options.devices) throw new AccessError('forbidden');
    const device = this.options.devices.authenticateFromState(
      state,
      credential.token,
      this.options.requiredDeviceScopes ?? [],
    );
    if (device.principal === null && this.options.allowHouseholdManagement) return false;
    if (
      device.principal?.role === 'owner' &&
      this.options.ownerDeviceScope &&
      device.scopes.includes(this.options.ownerDeviceScope)
    )
      return true;
    throw new AccessError('forbidden');
  }

  prepareUpdate(id: string, displayName?: string): PreparedProfileUpdate {
    const name = displayName?.trim();
    if (!id || (name !== undefined && (!name || name.length > 100))) throw new AccessError('invalid');
    return {
      id,
      name,
      apply: (state, credential) => {
        const owner = this.authorize(state, credential);
        const profile = state.householdProfiles!.find((item) => item.id === id);
        const principal = state.principals.find((item) => item.id === id);
        if (
          !profile ||
          !principal ||
          principal.passwordHash !== null ||
          state.passkeys.some((key) => key.principalId === id)
        )
          throw new AccessError('forbidden');
        if (!owner && (principal.role === 'owner' || principal.pendingRole === 'owner'))
          throw new AccessError('forbidden');
        if (name !== undefined) profile.name = name;
      },
    };
  }

  /** Application deletion must commit learner data and this mutation together. */
  prepareRemove(id: string, epoch: number, confirmed: boolean): PreparedProfileRemoval {
    if (!id || !Number.isSafeInteger(epoch) || epoch < 0 || !confirmed) throw new AccessError('invalid');
    return {
      id,
      apply: (state, credential) => {
        const owner = this.authorize(state, credential);
        if (owner && credential.kind === 'session')
          this.access.sessionFromState(state, credential.token, true, true);
        const profile = state.householdProfiles!.find((item) => item.id === id);
        const principal = state.principals.find((item) => item.id === id);
        if (!profile || profile.epoch !== epoch) throw new AccessError('conflict');
        if (
          !principal ||
          principal.role !== 'member' ||
          principal.pendingRole ||
          principal.passwordHash !== null ||
          state.passkeys.some((key) => key.principalId === id)
        )
          throw new AccessError('forbidden');
        if (state.householdProfiles!.length <= (this.options.minimumProfiles ?? 0))
          throw new AccessError('conflict', 'The last household profile cannot be deleted');
        removePrincipalFromState(state, id);
        state.householdProfiles = state.householdProfiles!.filter((item) => item.id !== id);
        state.deviceTokens = state.deviceTokens.filter((device) => device.defaultProfileId !== id);
        state.tokens = state.tokens.filter((token) => token.defaultProfileId !== id);
        for (const session of state.sessions) {
          if (session.selectedProfileId !== id) continue;
          delete session.selectedProfileId;
          delete session.selectedProfileEpoch;
          delete session.selectedProfileSource;
        }
      },
    };
  }

  /** Allocate once before application transaction retries; apply revalidates current authority. */
  prepareCreate(displayName: string): PreparedProfileCreation {
    const name = displayName.trim();
    if (!name || name.length > 100) throw new AccessError('invalid');
    const id = randomUUID();
    const createdAt = this.access.now();
    return {
      id,
      name,
      apply: (state, credential) => {
        this.authorize(state, credential);
        const base = name.slice(0, 80);
        let loginName = base;
        for (
          let suffix = 2;
          state.principals.some((principal) => principal.name.toLowerCase() === loginName.toLowerCase());
          suffix++
        )
          loginName = `${base} (${suffix})`;
        createPrincipalFromState(state, {
          id,
          name: loginName,
          passwordHash: null,
          role: 'member',
          epoch: 0,
          createdAt,
        });
        state.householdProfiles!.push({ id, name, epoch: 0 });
        return id;
      },
    };
  }
}
