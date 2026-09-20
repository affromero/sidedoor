import { AccessError, type AccessService } from '../core/service';

/** Credential management depends on authenticated identity, independently of WebAuthn origin support. */
export class PasskeyManagement {
  constructor(protected readonly access: AccessService) {}

  async list(token: string) {
    const state = await this.access.store.read();
    const { principal } = this.access.sessionFromState(state, token);
    if (!principal) throw new AccessError('forbidden');
    return state.passkeys
      .filter((key) => key.principalId === principal.id)
      .map((key) => ({ id: key.id, name: key.name, createdAt: key.createdAt, backedUp: key.backedUp }));
  }

  async remove(token: string, id: string): Promise<void> {
    await this.access.store.transact((state) => {
      const { principal } = this.access.sessionFromState(state, token, false, true);
      if (!principal) throw new AccessError('forbidden');
      const key = state.passkeys.find((item) => item.id === id);
      if (!key || key.principalId !== principal.id) throw new AccessError('forbidden');
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
