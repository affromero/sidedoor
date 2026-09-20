import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { StateStore } from '../storage/index';
import { hashConfiguredPassword, hashPassword, passwordHashNeedsUpgrade, verifyPassword } from './password';
import type { AccessState, Principal, Session } from './state';
import { ACCESS_ERROR_BRAND, hasAccessErrorBrand } from './error-brand';
import { PrincipalManagement } from './principals';

export class AccessError extends Error {
  readonly [ACCESS_ERROR_BRAND] = 'access';
  constructor(
    public readonly code: 'unauthorized' | 'forbidden' | 'invalid' | 'rate_limited' | 'conflict',
    message: string = code,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}
export function isAccessError(error: unknown): error is AccessError {
  return (
    hasAccessErrorBrand(error, 'access') &&
    'code' in (error as Error) &&
    typeof (error as AccessError).code === 'string' &&
    ['unauthorized', 'forbidden', 'invalid', 'rate_limited', 'conflict'].includes((error as AccessError).code)
  );
}
export const tokenHash = (token: string): string =>
  // Tokens are 256-bit random credentials. Passwords use the password module's configured scrypt parameters.
  createHash('sha256').update(token).digest('hex');
export const rateLimitKey = (scope: string): string => `rate:${scope}`;
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Apply a mode transition inside an already-authorized storage transaction. */
export function transitionAccessMode(state: AccessState, mode: AccessState['mode']): void {
  if (state.mode === mode) return;
  state.mode = mode;
  state.policyEpoch++;
  state.householdEpoch++;
  state.sessions = state.sessions.filter((session) => session.principalId !== null);
  state.deviceTokens = state.deviceTokens.filter((device) => device.principalId !== null);
  state.tokens = state.tokens.filter((token) => token.kind !== 'pair' || token.principalId !== null);
  state.invitations = [];
}
export interface AccessOptions {
  store: StateStore<AccessState>;
  sessionTtlMs?: number;
  householdSessionTtlMs?: number;
  recentAuthMs?: number;
  allowOpenHousehold?: boolean;
  now?: () => number;
}
export interface AuthenticatedSession {
  session: Session;
  principal: Omit<Principal, 'passwordHash'> | null;
}

export class AccessService {
  readonly store: StateStore<AccessState>;
  readonly now: () => number;
  readonly recentAuthMs: number;
  private readonly ttl: number;
  private readonly householdTtl: number;
  private readonly allowOpenHousehold: boolean;

  constructor(options: AccessOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.ttl = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.householdTtl = options.householdSessionTtlMs ?? this.ttl;
    this.allowOpenHousehold = options.allowOpenHousehold ?? false;
    this.recentAuthMs = options.recentAuthMs ?? 5 * 60 * 1000;
    if (
      ![this.ttl, this.householdTtl, this.recentAuthMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new AccessError('invalid');
  }

  sessionFromState(state: AccessState, token: string, owner = false, recent = false): AuthenticatedSession {
    const session = state.sessions.find((item) => item.id === tokenHash(token));
    if (!session || session.expiresAt <= this.now()) throw new AccessError('unauthorized');
    const principal = session.principalId
      ? state.principals.find((item) => item.id === session.principalId)
      : null;
    if (session.principalId && (!principal || principal.epoch !== session.epoch))
      throw new AccessError('unauthorized');
    if (!principal && (state.mode !== 'household' || state.householdEpoch !== session.epoch))
      throw new AccessError('unauthorized');
    if (owner && principal?.role !== 'owner') throw new AccessError('forbidden');
    if (recent && session.authenticatedAt + this.recentAuthMs <= this.now())
      throw new AccessError('unauthorized');
    const safePrincipal = principal
      ? {
          id: principal.id,
          name: principal.name,
          role: principal.role,
          epoch: principal.epoch,
          createdAt: principal.createdAt,
        }
      : null;
    return { session, principal: safePrincipal };
  }

  async authenticate(token: string, owner = false, recent = false): Promise<AuthenticatedSession> {
    return this.sessionFromState(await this.store.read(), token, owner, recent);
  }

  issueSession(state: AccessState, principalId: string | null, name: string): string {
    const principal = principalId ? state.principals.find((item) => item.id === principalId) : null;
    if (principalId && !principal) throw new AccessError('unauthorized');
    const raw = newToken();
    const now = this.now();
    state.sessions = state.sessions.filter((session) => session.expiresAt > now);
    if (
      state.sessions.length >= 10_000 ||
      (!principal && state.sessions.filter((session) => session.principalId === null).length >= 1000)
    )
      throw new AccessError('rate_limited');
    state.sessions.push({
      id: tokenHash(raw),
      principalId,
      epoch: principal?.epoch ?? state.householdEpoch,
      name: name.slice(0, 100),
      createdAt: now,
      authenticatedAt: now,
      expiresAt: now + (principal ? this.ttl : this.householdTtl),
    });
    return raw;
  }

  /** Operator-only primitive. Expose through a local command, never an unauthenticated HTTP route. */
  async issueOperatorToken(principalId?: string): Promise<string> {
    return this.store.transact((state) => {
      const principal = state.principals.find((item) => item.id === principalId);
      if (principalId && !principal) throw new AccessError('invalid');
      if (!principalId && state.principals.some((item) => item.role === 'owner'))
        throw new AccessError('conflict');
      const raw = newToken();
      state.tokens = state.tokens.filter(
        (item) =>
          item.expiresAt > this.now() &&
          (principalId ? item.kind !== 'recover' || item.principalId !== principalId : item.kind !== 'claim'),
      );
      state.tokens.push({
        id: tokenHash(raw),
        kind: principalId ? 'recover' : 'claim',
        principalId: principalId ?? null,
        epoch: principal?.epoch,
        activatePendingOwner: principal?.pendingRole === 'owner' ? true : undefined,
        expiresAt: this.now() + 15 * 60 * 1000,
      });
      return raw;
    });
  }

  async claimOwner(
    token: string,
    name: string,
    password: string,
    mode: AccessState['mode'],
  ): Promise<string> {
    const normalized = this.validName(name);
    const snapshot = await this.store.read();
    if (
      !snapshot.tokens.some(
        (item) => item.id === tokenHash(token) && item.kind === 'claim' && item.expiresAt > this.now(),
      )
    )
      throw new AccessError('unauthorized');
    const passwordHash = await hashPassword(password);
    return this.store.transact((state) => {
      const claim = state.tokens.find(
        (item) => item.id === tokenHash(token) && item.kind === 'claim' && item.expiresAt > this.now(),
      );
      if (!claim || state.principals.some((item) => item.role === 'owner'))
        throw new AccessError('unauthorized');
      if (state.principals.some((item) => item.name.toLowerCase() === normalized.toLowerCase()))
        throw new AccessError('conflict');
      state.tokens = state.tokens.filter((item) => item.id !== claim.id);
      const principal: Principal = {
        id: randomUUID(),
        name: normalized,
        passwordHash,
        role: 'owner',
        epoch: 0,
        createdAt: this.now(),
      };
      state.principals.push(principal);
      state.mode = mode;
      return this.issueSession(state, principal.id, 'Owner setup');
    });
  }

  private validName(name: string): string {
    const value = name.trim();
    if (!value || value.length > 100) throw new AccessError('invalid');
    return value;
  }

  async addMember(ownerToken: string, name: string, password: string): Promise<string> {
    if (!password) throw new AccessError('invalid');
    return new PrincipalManagement(this).mutate(ownerToken, { kind: 'create', name, password });
  }

  /** Reserve an attempt before expensive verification, including concurrent requests. */
  async reserveAttempt(scope: string): Promise<void> {
    await this.store.transact((state) => {
      state.failures = state.failures.filter((item) => item.expiresAt > this.now());
      const key = rateLimitKey(scope);
      const current = state.failures.find((item) => item.key === key);
      if (current && current.count >= 10) throw new AccessError('rate_limited');
      if (!current && state.failures.length >= 1000) throw new AccessError('rate_limited');
      if (current) current.count++;
      else state.failures.push({ key, count: 1, expiresAt: this.now() + 15 * 60 * 1000 });
    });
  }

  async login(name: string, password: string, deviceName = 'Browser'): Promise<string> {
    const normalized = name.trim().toLowerCase();
    await this.reserveAttempt(`password:${normalized}`);
    const snapshot = await this.store.read();
    const candidates = snapshot.principals.filter((item) => item.name.toLowerCase() === normalized);
    const principal =
      candidates.find((item) => item.name === name.trim()) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    // The fixed dummy hash has the same work factor as a real stored hash.
    const encoded = principal?.passwordHash ?? `scrypt:32768:${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(password, encoded);
    if (!principal || !valid) throw new AccessError('unauthorized');
    const replacement = passwordHashNeedsUpgrade(encoded) ? await hashConfiguredPassword(password) : encoded;
    return this.store.transact((state) => {
      const current = state.principals.find((item) => item.id === principal.id);
      if (!current || current.passwordHash !== encoded || current.epoch !== principal.epoch)
        throw new AccessError('unauthorized');
      if (replacement !== encoded) {
        current.passwordHash = replacement;
        current.epoch++;
      }
      state.failures = state.failures.filter((item) => item.key !== rateLimitKey(`password:${normalized}`));
      return this.issueSession(state, current.id, deviceName);
    });
  }

  async configureHousehold(ownerToken: string, password: string | null): Promise<void> {
    await this.authenticate(ownerToken, true, true);
    if (password === null && !this.allowOpenHousehold) throw new AccessError('forbidden');
    const encoded = password === null ? null : await hashPassword(password);
    await this.store.transact((state) => {
      this.sessionFromState(state, ownerToken, true, true);
      state.householdPasswordHash = encoded;
      state.householdEpoch++;
      state.sessions = state.sessions.filter((item) => item.principalId !== null);
    });
  }

  async setRole(ownerToken: string, principalId: string, role: Principal['role']): Promise<void> {
    await new PrincipalManagement(this).mutate(ownerToken, { kind: 'update', id: principalId, role });
  }

  async setMode(ownerToken: string, mode: AccessState['mode']): Promise<void> {
    await this.store.transact((state) => {
      this.sessionFromState(state, ownerToken, true, true);
      transitionAccessMode(state, mode);
    });
  }

  private async passwordProof(auth: AuthenticatedSession, password: string) {
    if (!auth.principal) throw new AccessError('forbidden');
    await this.reserveAttempt(`password:${auth.principal.name.toLowerCase()}`);
    const snapshot = await this.store.read();
    const principal = snapshot.principals.find((item) => item.id === auth.principal?.id);
    if (!principal?.passwordHash || !(await verifyPassword(password, principal.passwordHash)))
      throw new AccessError('unauthorized');
    return principal;
  }

  async reauthenticate(token: string, password: string): Promise<string> {
    const auth = await this.authenticate(token);
    const principal = await this.passwordProof(auth, password);
    return this.store.transact((state) => {
      this.sessionFromState(state, token);
      const current = state.principals.find((item) => item.id === principal.id);
      if (!current || current.epoch !== principal.epoch || current.passwordHash !== principal.passwordHash)
        throw new AccessError('unauthorized');
      state.sessions = state.sessions.filter((item) => item.id !== auth.session.id);
      state.failures = state.failures.filter(
        (item) => item.key !== rateLimitKey(`password:${principal.name.toLowerCase()}`),
      );
      return this.issueSession(state, principal.id, auth.session.name);
    });
  }

  async rotatePrincipalCredential(
    token: string,
    password: string,
    currentPassword?: string,
  ): Promise<string> {
    const auth = await this.authenticate(token, false, currentPassword === undefined);
    const proof = currentPassword === undefined ? null : await this.passwordProof(auth, currentPassword);
    if (!auth.principal) throw new AccessError('forbidden');
    const encoded = await hashPassword(password);
    return this.store.transact((state) => {
      const current = this.sessionFromState(state, token, false, proof === null);
      const principal = state.principals.find((item) => item.id === current.principal?.id);
      if (!principal) throw new AccessError('forbidden');
      if (proof && (principal.epoch !== proof.epoch || principal.passwordHash !== proof.passwordHash))
        throw new AccessError('unauthorized');
      principal.passwordHash = encoded;
      principal.epoch++;
      state.sessions = state.sessions.filter((item) => item.principalId !== principal.id);
      state.challenges = state.challenges.filter((item) => item.principalId !== principal.id);
      state.tokens = state.tokens.filter(
        (item) => item.principalId !== principal.id || item.kind !== 'recover',
      );
      state.failures = state.failures.filter(
        (item) => item.key !== rateLimitKey(`password:${principal.name.toLowerCase()}`),
      );
      return this.issueSession(state, principal.id, auth.session.name);
    });
  }

  async enterHousehold(
    password: string,
    deviceName = 'Household browser',
    policy?: { householdEpoch: number; policyEpoch: number },
  ): Promise<string> {
    await this.reserveAttempt('household');
    const snapshot = await this.store.read();
    if (
      snapshot.mode !== 'household' ||
      !snapshot.householdPasswordHash ||
      !(await verifyPassword(password, snapshot.householdPasswordHash))
    )
      throw new AccessError('unauthorized');
    const replacement = passwordHashNeedsUpgrade(snapshot.householdPasswordHash)
      ? await hashConfiguredPassword(password)
      : snapshot.householdPasswordHash;
    return this.store.transact((state) => {
      if (state.mode !== 'household' || state.householdPasswordHash !== snapshot.householdPasswordHash)
        throw new AccessError('unauthorized');
      if (
        policy &&
        (state.householdEpoch !== policy.householdEpoch || state.policyEpoch !== policy.policyEpoch)
      )
        throw new AccessError('unauthorized');
      if (replacement !== snapshot.householdPasswordHash) {
        state.householdPasswordHash = replacement;
        state.householdEpoch++;
        state.sessions = state.sessions.filter((item) => item.principalId !== null);
      }
      state.failures = state.failures.filter((item) => item.key !== rateLimitKey('household'));
      return this.issueSession(state, null, deviceName);
    });
  }

  /** Explicitly enabled household convenience. This grants no authenticated identity. */
  async enterOpenHousehold(deviceName = 'Household browser', existingToken?: string): Promise<string> {
    return this.store.transact((state) => this.issueOpenHouseholdSession(state, deviceName, existingToken));
  }

  /** Compose admission with other state mutations in the caller's transaction. */
  issueOpenHouseholdSession(
    state: AccessState,
    deviceName = 'Household browser',
    existingToken?: string,
  ): string {
    if (!this.allowOpenHousehold) throw new AccessError('forbidden');
    if (
      state.mode !== 'household' ||
      state.householdPasswordHash !== null ||
      !state.principals.some((principal) => principal.role === 'owner')
    )
      throw new AccessError('forbidden');
    const now = this.now();
    if (
      existingToken &&
      state.sessions.some(
        (session) =>
          session.id === tokenHash(existingToken) &&
          session.principalId === null &&
          session.epoch === state.householdEpoch &&
          session.expiresAt > now,
      )
    )
      return existingToken;
    state.failures = state.failures.filter((attempt) => attempt.expiresAt > now);
    const key = rateLimitKey('open-household');
    const attempts = state.failures.find((attempt) => attempt.key === key);
    if (attempts && attempts.count >= 120) throw new AccessError('rate_limited');
    if (attempts) attempts.count++;
    else {
      if (state.failures.length >= 1000) throw new AccessError('rate_limited');
      state.failures.push({ key, count: 1, expiresAt: now + 60_000 });
    }
    return this.issueSession(state, null, deviceName);
  }

  async supportsOpenHousehold(): Promise<boolean> {
    if (!this.allowOpenHousehold) return false;
    const state = await this.store.read();
    return (
      state.mode === 'household' &&
      state.householdPasswordHash === null &&
      state.principals.some((principal) => principal.role === 'owner')
    );
  }

  async sessions(token: string): Promise<Session[]> {
    const state = await this.store.read();
    const auth = this.sessionFromState(state, token);
    return state.sessions.filter(
      (session) =>
        session.expiresAt > this.now() &&
        (auth.principal?.role === 'owner' ||
          (auth.principal ? session.principalId === auth.principal.id : session.id === auth.session.id)),
    );
  }

  async revokeSession(token: string, id: string): Promise<void> {
    await this.store.transact((state) => {
      const auth = this.sessionFromState(state, token);
      const target = state.sessions.find((item) => item.id === id);
      if (!target) return;
      if (
        auth.principal?.role !== 'owner' &&
        (auth.principal ? target.principalId !== auth.principal.id : target.id !== auth.session.id)
      )
        throw new AccessError('forbidden');
      state.sessions = state.sessions.filter((item) => item.id !== id);
    });
  }

  async logout(token: string): Promise<void> {
    await this.store.transact((state) => {
      state.sessions = state.sessions.filter((session) => session.id !== tokenHash(token));
    });
  }

  async recoveryCodes(token: string): Promise<string[]> {
    return this.store.transact((state) => {
      const { principal } = this.sessionFromState(state, token, false, true);
      if (!principal) throw new AccessError('forbidden');
      const codes = Array.from({ length: 8 }, newToken);
      state.recoveryCodes = state.recoveryCodes.filter((item) => item.principalId !== principal.id);
      state.recoveryCodes.push(...codes.map((code) => ({ id: tokenHash(code), principalId: principal.id })));
      return codes;
    });
  }

  async recover(code: string, password: string): Promise<string> {
    const snapshot = await this.store.read();
    const hash = tokenHash(code);
    if (
      !snapshot.recoveryCodes.some((item) => item.id === hash) &&
      !snapshot.tokens.some(
        (item) => item.id === hash && item.kind === 'recover' && item.expiresAt > this.now(),
      )
    )
      throw new AccessError('unauthorized');
    const encoded = await hashPassword(password);
    return this.store.transact((state) => {
      const saved = state.recoveryCodes.find((item) => item.id === hash);
      const operator = state.tokens.find(
        (item) => item.id === hash && item.kind === 'recover' && item.expiresAt > this.now(),
      );
      const principal = state.principals.find(
        (item) => item.id === (saved?.principalId ?? operator?.principalId),
      );
      if (!principal) throw new AccessError('unauthorized');
      if (!saved && operator?.epoch !== undefined && operator.epoch !== principal.epoch)
        throw new AccessError('unauthorized');
      if (!saved && operator?.activatePendingOwner) {
        if (operator.epoch === undefined || principal.pendingRole !== 'owner')
          throw new AccessError('unauthorized');
        principal.role = 'owner';
        delete principal.pendingRole;
      }
      principal.passwordHash = encoded;
      principal.epoch++;
      state.sessions = state.sessions.filter((item) => item.principalId !== principal.id);
      state.recoveryCodes = state.recoveryCodes.filter((item) => item.principalId !== principal.id);
      state.tokens = state.tokens.filter((item) => item.principalId !== principal.id);
      state.challenges = state.challenges.filter((item) => item.principalId !== principal.id);
      return this.issueSession(state, principal.id, 'Recovered browser');
    });
  }
}
