import { randomUUID } from 'node:crypto';
import { AccessError, AccessService, tokenHash } from './service';
import { hashPassword } from './password';
import { hasAccessErrorBrand } from './error-brand';
import type { AccessState, Principal } from './state';

export type PrincipalMutation =
  | { kind: 'create'; name: string; password?: string; role?: Principal['role'] }
  | { kind: 'update'; id: string; password?: string; role?: Principal['role'] }
  | { kind: 'delete'; id: string };

/** Prepared on the server, then applied inside the application's own transaction. */
export interface PreparedPrincipalMutation {
  readonly id: string;
  readonly kind: PrincipalMutation['kind'];
  apply(state: AccessState, ownerToken: string): string;
}

/** Apply creation only after the caller has authorized the current state transaction. */
export function createPrincipalFromState(state: AccessState, principal: Principal): void {
  if (!principal.name.trim() || principal.name.length > 100) throw new AccessError('invalid');
  if (
    state.principals.some(
      (item) => item.id === principal.id || item.name.toLowerCase() === principal.name.toLowerCase(),
    )
  )
    throw new AccessError('conflict');
  if (principal.passwordHash === null && (principal.role === 'owner' || state.mode === 'individual'))
    throw new AccessError('invalid');
  state.principals.push({ ...principal });
}

function revokePrincipalAccess(state: AccessState, principal: Principal, remove: boolean): void {
  const sessionIds = new Set(
    state.sessions.filter((session) => session.principalId === principal.id).map((session) => session.id),
  );
  state.sessions = state.sessions.filter(
    (session) =>
      session.principalId !== principal.id &&
      (state.householdProfiles !== undefined || session.selectedProfileId !== principal.id),
  );
  state.challenges = state.challenges.filter(
    (challenge) =>
      challenge.principalId !== principal.id &&
      !sessionIds.has(challenge.sessionId ?? '') &&
      !sessionIds.has(challenge.originalSessionId ?? ''),
  );
  state.tokens = state.tokens.filter(
    (token) => token.principalId !== principal.id && !sessionIds.has(token.issuerSessionId ?? ''),
  );
  state.deviceTokens = state.deviceTokens.filter(
    (device) => device.principalId !== principal.id && !sessionIds.has(device.issuerSessionId ?? ''),
  );
  state.invitations = state.invitations.filter((invitation) => invitation.issuerPrincipalId !== principal.id);
  state.recoveryCodes = state.recoveryCodes.filter((code) => code.principalId !== principal.id);
  state.failures = state.failures.filter(
    (failure) => failure.key !== tokenHash(`password:${principal.name.toLowerCase()}`),
  );
  if (remove) state.passkeys = state.passkeys.filter((passkey) => passkey.principalId !== principal.id);
}

/** The caller must authorize deletion inside this same state transaction. */
export function removePrincipalFromState(state: AccessState, id: string): void {
  const principal = state.principals.find((item) => item.id === id);
  if (!principal) throw new AccessError('invalid');
  if (principal.role === 'owner' && !state.principals.some((item) => item.id !== id && item.role === 'owner'))
    throw new AccessError('conflict', 'The last owner cannot be deleted.');
  revokePrincipalAccess(state, principal, true);
  state.principals = state.principals.filter((item) => item.id !== id);
}

export class PrincipalManagement {
  constructor(private readonly access: AccessService) {}

  /** Local operator command only. Never expose this method through an HTTP action. */
  async resetPasswordForOperator(id: string, password: string): Promise<Principal['role']> {
    const encoded = await hashPassword(password);
    return this.access.store.transact((state) => {
      const principal = state.principals.find((item) => item.id === id);
      if (!principal) throw new AccessError('invalid');
      principal.passwordHash = encoded;
      principal.epoch++;
      revokePrincipalAccess(state, principal, false);
      return principal.role;
    });
  }

  async prepare(mutation: PrincipalMutation): Promise<PreparedPrincipalMutation> {
    const password = mutation.kind === 'delete' ? undefined : mutation.password;
    // Existing account forms submit an empty password when no reset was requested.
    const encoded = password
      ? await hashPassword(password).catch((error) => {
          if (hasAccessErrorBrand(error, 'password_policy'))
            throw new AccessError(
              'invalid',
              'Password must contain at least 12 characters and at most 1024 bytes',
            );
          if (hasAccessErrorBrand(error, 'password_busy')) throw new AccessError('rate_limited');
          throw error;
        })
      : undefined;
    const name = mutation.kind === 'create' ? mutation.name.trim() : undefined;
    if (mutation.kind === 'create' && (!name || name.length > 100)) throw new AccessError('invalid');
    if (
      mutation.kind !== 'delete' &&
      mutation.role !== undefined &&
      !['owner', 'member'].includes(mutation.role)
    )
      throw new AccessError('invalid');
    const id = mutation.kind === 'create' ? randomUUID() : mutation.id;
    const kind = mutation.kind;
    const requestedRole = mutation.kind === 'delete' ? undefined : mutation.role;
    return {
      id,
      kind,
      apply: (state, ownerToken) => {
        const actor = this.access.sessionFromState(state, ownerToken, true, true).principal;
        if (!actor) throw new AccessError('forbidden');
        if (kind === 'create') {
          const role = requestedRole ?? 'member';
          createPrincipalFromState(state, {
            id,
            name: name!,
            passwordHash: encoded ?? null,
            role,
            epoch: 0,
            createdAt: this.access.now(),
          });
          return id;
        }
        const principal = state.principals.find((item) => item.id === id);
        if (!principal) throw new AccessError('invalid');
        if (id === actor.id && (kind === 'delete' || requestedRole === 'member'))
          throw new AccessError('forbidden');
        const losesOwnership =
          principal.role === 'owner' && (kind === 'delete' || requestedRole === 'member');
        if (losesOwnership && !state.principals.some((item) => item.id !== id && item.role === 'owner'))
          throw new AccessError('conflict');
        if (kind === 'delete') {
          removePrincipalFromState(state, id);
          return id;
        }
        const role = requestedRole ?? principal.role;
        if (
          role === 'owner' &&
          !encoded &&
          !principal.passwordHash &&
          !state.passkeys.some((passkey) => passkey.principalId === id)
        )
          throw new AccessError('invalid');
        const roleChanged =
          requestedRole !== undefined && (role !== principal.role || principal.pendingRole !== undefined);
        if (encoded || roleChanged) {
          if (encoded) principal.passwordHash = encoded;
          if (requestedRole !== undefined) {
            principal.role = role;
            delete principal.pendingRole;
          }
          principal.epoch++;
          revokePrincipalAccess(state, principal, false);
        }
        return id;
      },
    };
  }

  async mutate(ownerToken: string, mutation: PrincipalMutation): Promise<string> {
    await this.access.authenticate(ownerToken, true, true);
    const prepared = await this.prepare(mutation);
    return this.access.store.transact((state) => prepared.apply(state, ownerToken));
  }
}
