import { AccessError, type AccessService } from '../core/service';
import type { AccessState } from '../core/state';

function revokeHouseholdKey(state: AccessState, id: string): void {
  const key = state.passkeys.find((item) => item.id === id);
  if (!key || key.scope !== 'household' || key.householdEpoch !== state.householdEpoch)
    throw new AccessError('forbidden');
  state.passkeys = state.passkeys.filter((item) => item.id !== id);
  state.householdEpoch++;
  for (const remaining of state.passkeys) {
    if (remaining.scope === 'household') remaining.householdEpoch = state.householdEpoch;
  }
  state.sessions = state.sessions.filter((item) => item.principalId !== null);
  state.challenges = state.challenges.filter((item) => !item.kind.endsWith('-household'));
}

/** Credential management depends on authenticated identity, independently of WebAuthn origin support. */
export class PasskeyManagement {
  constructor(protected readonly access: AccessService) {}

  async list(token: string) {
    const state = await this.access.store.read();
    const { principal } = this.access.sessionFromState(state, token);
    if (!principal) throw new AccessError('forbidden');
    return state.passkeys
      .filter((key) => key.scope !== 'household' && key.principalId === principal.id)
      .map((key) => ({ id: key.id, name: key.name, createdAt: key.createdAt, backedUp: key.backedUp }));
  }

  async listHousehold(token: string) {
    const state = await this.access.store.read();
    this.access.sessionFromState(state, token, true);
    return state.passkeys
      .filter((key) => key.scope === 'household' && key.householdEpoch === state.householdEpoch)
      .map((key) => ({ id: key.id, name: key.name, createdAt: key.createdAt, backedUp: key.backedUp }));
  }

  async removeHousehold(token: string, id: string): Promise<void> {
    await this.access.store.transact((state) => {
      this.access.sessionFromState(state, token, true, true);
      revokeHouseholdKey(state, id);
    });
  }

  async remove(token: string, id: string): Promise<void> {
    await this.access.store.transact((state) => {
      const { principal } = this.access.sessionFromState(state, token, false, true);
      if (!principal) throw new AccessError('forbidden');
      const key = state.passkeys.find((item) => item.id === id);
      if (!key) throw new AccessError('forbidden');
      if (key.scope === 'household' || key.principalId !== principal.id) throw new AccessError('forbidden');
      const stored = state.principals.find((item) => item.id === principal.id);
      if (!stored) throw new AccessError('unauthorized');
      if (
        !stored.passwordHash &&
        state.passkeys.filter((item) => item.principalId === principal.id).length === 1
      )
        throw new AccessError('conflict');
      state.passkeys = state.passkeys.filter((item) => item.id !== id);
      stored.epoch++;
      state.sessions = state.sessions.filter((item) => item.principalId !== principal.id);
      state.challenges = state.challenges.filter((item) => item.principalId !== principal.id);
    });
  }
}
