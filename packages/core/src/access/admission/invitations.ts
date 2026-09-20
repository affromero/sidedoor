import { randomUUID } from 'node:crypto';
import { AccessError, AccessService, newToken, tokenHash } from '../core/service';
import { hashPassword } from '../core/password';
import type { AccessState } from '../core/state';

export class InvitationService {
  constructor(private readonly access: AccessService) {}

  async issue(ownerToken: string, options: { ttlMs?: number; uses?: number | null } = {}): Promise<string> {
    return (await this.issueDetailed(ownerToken, options)).code;
  }

  async issueDetailed(
    ownerToken: string,
    options: { ttlMs?: number; uses?: number | null } = {},
  ): Promise<{ code: string; mode: AccessState['mode'] }> {
    const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
    const uses = options.uses === undefined ? 1 : options.uses;
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > 30 * 24 * 60 * 60 * 1000 ||
      (uses !== null && (!Number.isSafeInteger(uses) || uses < 1))
    )
      throw new AccessError('invalid');
    return this.access.store.transact((state) => {
      const auth = this.access.sessionFromState(state, ownerToken, true, true);
      if (!auth.principal) throw new AccessError('forbidden');
      state.invitations = state.invitations.filter((item) => item.expiresAt > this.access.now());
      if (state.invitations.length >= 100) throw new AccessError('rate_limited');
      const raw = newToken();
      state.invitations.push({
        id: tokenHash(raw),
        issuerPrincipalId: auth.principal.id,
        issuerEpoch: auth.principal.epoch,
        policyEpoch: state.policyEpoch,
        householdEpoch: state.householdEpoch,
        mode: state.mode,
        remaining: uses,
        expiresAt: this.access.now() + ttl,
      });
      return { code: raw, mode: state.mode };
    });
  }

  private valid(state: AccessState, code: string) {
    const invitation = state.invitations.find(
      (item) => item.id === tokenHash(code) && item.expiresAt > this.access.now(),
    );
    if (
      !invitation ||
      invitation.mode !== state.mode ||
      invitation.policyEpoch !== state.policyEpoch ||
      (invitation.mode === 'household' && invitation.householdEpoch !== state.householdEpoch)
    )
      throw new AccessError('unauthorized');
    const issuer = state.principals.find((item) => item.id === invitation.issuerPrincipalId);
    if (!issuer || issuer.role !== 'owner' || issuer.epoch !== invitation.issuerEpoch)
      throw new AccessError('unauthorized');
    return invitation;
  }

  async redeem(code: string, enrollment?: { name: string; password: string }): Promise<string> {
    const snapshot = await this.access.store.read();
    const invitation = this.valid(snapshot, code);
    if (invitation.mode === 'household' && enrollment) throw new AccessError('invalid');
    let name: string | undefined;
    let encoded: string | undefined;
    if (invitation.mode === 'individual') {
      name = enrollment?.name.trim();
      if (!name || name.length > 100 || !enrollment) throw new AccessError('invalid');
      encoded = await hashPassword(enrollment.password);
    }
    return this.access.store.transact((state) => {
      const current = this.valid(state, code);
      let principalId: string | null = null;
      if (current.mode === 'individual') {
        if (!name || !encoded) throw new AccessError('invalid');
        if (state.principals.some((item) => item.name.toLowerCase() === name.toLowerCase()))
          throw new AccessError('conflict');
        principalId = randomUUID();
        state.principals.push({
          id: principalId,
          name,
          passwordHash: encoded,
          role: 'member',
          epoch: 0,
          createdAt: this.access.now(),
        });
      }
      if (current.remaining === 1)
        state.invitations = state.invitations.filter((item) => item.id !== current.id);
      else if (current.remaining !== null) current.remaining--;
      return this.access.issueSession(state, principalId, 'Invited browser');
    });
  }

  async revoke(ownerToken: string, id: string): Promise<void> {
    await this.access.store.transact((state) => {
      this.access.sessionFromState(state, ownerToken, true, true);
      state.invitations = state.invitations.filter((item) => item.id !== id);
    });
  }

  async list(ownerToken: string): Promise<AccessState['invitations']> {
    const state = await this.access.store.read();
    this.access.sessionFromState(state, ownerToken, true);
    return state.invitations.filter((item) => item.expiresAt > this.access.now());
  }
}
