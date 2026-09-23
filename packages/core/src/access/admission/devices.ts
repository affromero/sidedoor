import {
  AccessError,
  AccessService,
  isAccessError,
  newToken,
  tokenHash,
  type AuthenticatedSession,
} from '../core/service';
import type { AccessState } from '../core/state';
import { HouseholdProfileService } from '../identity/profiles';

export interface DeviceOptions {
  access: AccessService;
  /** Current permissions the principal may delegate. Household admission must have its own limited set. */
  scopesFor(principal: AuthenticatedSession['principal']): readonly string[];
  deviceTtlMs?: number;
  maxDevicesPerProfile?: number;
  /** Formatting for newly issued device credentials. Never used as authentication evidence. */
  tokenPrefix?: string;
  /** Owners must explicitly delegate this scope before a device may manage other devices. */
  managementScope?: string;
}
export interface DeviceIdentity {
  id: string;
  principal: AuthenticatedSession['principal'];
  scopes: string[];
  name: string;
  expiresAt: number | null;
  defaultProfileId?: string;
}

export class DeviceService {
  private readonly ttl: number;
  private readonly prefix: string;
  private readonly limit: number;
  constructor(private readonly options: DeviceOptions) {
    this.ttl = options.deviceTtlMs ?? 90 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1) throw new AccessError('invalid');
    this.limit = options.maxDevicesPerProfile ?? 100;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new AccessError('invalid');
    this.prefix = options.tokenPrefix ?? '';
    if (
      typeof this.prefix !== 'string' ||
      (this.prefix !== '' && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(this.prefix))
    )
      throw new AccessError('invalid');
    if (options.managementScope !== undefined && !/^[a-zA-Z0-9_.:-]{1,100}$/.test(options.managementScope))
      throw new AccessError('invalid');
  }

  private principal(
    state: AccessState,
    principalId: string | null,
    epoch: number,
  ): AuthenticatedSession['principal'] {
    if (principalId === null) {
      if (state.mode !== 'household' || epoch !== state.householdEpoch) throw new AccessError('unauthorized');
      return null;
    }
    const principal = state.principals.find((item) => item.id === principalId);
    if (!principal || principal.epoch !== epoch) throw new AccessError('unauthorized');
    return {
      id: principal.id,
      name: principal.name,
      role: principal.role,
      epoch: principal.epoch,
      createdAt: principal.createdAt,
    };
  }

  private scopedPrincipal(
    state: AccessState,
    principal: AuthenticatedSession['principal'],
    defaultProfileId?: string,
  ): AuthenticatedSession['principal'] {
    if (principal || !defaultProfileId) return principal;
    const profile = state.householdProfiles?.find((entry) => entry.id === defaultProfileId);
    if (!profile) return null;
    const owner = state.principals.find(
      (entry) => entry.id === (profile.ownerPrincipalId ?? profile.id) && entry.role === 'owner',
    );
    return owner ? this.principal(state, owner.id, owner.epoch) : null;
  }

  async issuePairing(
    sessionToken: string,
    scopes: readonly string[],
    name: string,
    options: { defaultProfileId?: string } = {},
  ): Promise<string> {
    if (
      !scopes.length ||
      scopes.length > 32 ||
      scopes.some((scope) => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(scope)) ||
      !name.trim() ||
      name.length > 100
    )
      throw new AccessError('invalid');
    return this.options.access.store.transact((state) => {
      const auth = this.options.access.sessionFromState(state, sessionToken, false, true);
      let binding: { defaultProfileId: string; defaultProfileEpoch: number } | undefined;
      if (options.defaultProfileId !== undefined) {
        if (auth.principal !== null) throw new AccessError('forbidden');
        const selected = new HouseholdProfileService(this.options.access).selectedFromState(
          state,
          sessionToken,
        );
        const profile = state.householdProfiles?.find((profile) => profile.id === selected?.id);
        if (!profile || profile.id !== options.defaultProfileId) throw new AccessError('forbidden');
        binding = { defaultProfileId: profile.id, defaultProfileEpoch: profile.epoch };
      }
      const authority = this.scopedPrincipal(state, auth.principal, binding?.defaultProfileId);
      const allowed = this.options.scopesFor(authority);
      if (scopes.some((scope) => !allowed.includes(scope))) throw new AccessError('forbidden');
      const now = this.options.access.now();
      state.tokens = state.tokens.filter((item) => item.expiresAt > now);
      if (
        state.tokens.filter((item) => item.kind === 'pair' && item.issuerSessionId === auth.session.id)
          .length >= 10
      )
        throw new AccessError('rate_limited');
      const raw = newToken();
      state.tokens.push({
        id: tokenHash(raw),
        kind: 'pair',
        principalId: auth.principal?.id ?? null,
        epoch: auth.session.epoch,
        issuerSessionId: auth.session.id,
        scopes: [...new Set(scopes)],
        deviceName: name.trim(),
        ...binding,
        expiresAt: now + 5 * 60 * 1000,
      });
      return raw;
    });
  }

  async redeemPairing(code: string): Promise<string> {
    return this.options.access.store.transact((state) => {
      const now = this.options.access.now();
      const pair = state.tokens.find(
        (item) => item.id === tokenHash(code) && item.kind === 'pair' && item.expiresAt > now,
      );
      if (
        !pair ||
        pair.epoch === undefined ||
        !pair.scopes?.length ||
        !pair.issuerSessionId ||
        !pair.deviceName
      )
        throw new AccessError('unauthorized');
      const issuer = state.sessions.find((item) => item.id === pair.issuerSessionId && item.expiresAt > now);
      if (!issuer || issuer.principalId !== pair.principalId || issuer.epoch !== pair.epoch)
        throw new AccessError('unauthorized');
      const principal = this.principal(state, pair.principalId, pair.epoch);
      if (
        pair.defaultProfileId !== undefined &&
        (principal !== null ||
          !state.householdProfiles?.some(
            (profile) => profile.id === pair.defaultProfileId && profile.epoch === pair.defaultProfileEpoch,
          ))
      )
        throw new AccessError('unauthorized');
      const allowed = this.options.scopesFor(this.scopedPrincipal(state, principal, pair.defaultProfileId));
      if (pair.scopes.some((scope) => !allowed.includes(scope))) throw new AccessError('forbidden');
      state.deviceTokens = state.deviceTokens.filter(
        (item) => item.expiresAt === null || item.expiresAt > now,
      );
      const active = state.deviceTokens.filter((item) => {
        if (
          item.principalId !== pair.principalId ||
          (pair.principalId === null && item.defaultProfileId !== pair.defaultProfileId)
        )
          return false;
        try {
          this.identityFromRecord(state, item, []);
          return true;
        } catch (error) {
          if (isAccessError(error) && error.code === 'unauthorized') return false;
          throw error;
        }
      });
      if (active.length >= this.limit) throw new AccessError('rate_limited');
      const raw = this.prefix + newToken();
      state.tokens = state.tokens.filter((item) => item.id !== pair.id);
      state.deviceTokens.push({
        id: tokenHash(raw),
        principalId: pair.principalId,
        issuerSessionId: pair.issuerSessionId,
        epoch: pair.epoch,
        scopes: pair.scopes,
        name: pair.deviceName,
        ...(pair.defaultProfileId !== undefined
          ? {
              defaultProfileId: pair.defaultProfileId,
              defaultProfileEpoch: pair.defaultProfileEpoch,
            }
          : {}),
        createdAt: now,
        expiresAt: now + this.ttl,
      });
      return raw;
    });
  }

  async authenticate(token: string, required: readonly string[]): Promise<DeviceIdentity> {
    return this.authenticateFromState(await this.options.access.store.read(), token, required);
  }

  /** Local operator primitive. Applications must never expose this method through an unauthenticated route. */
  async issueForOperator(principalId: string, scopes: readonly string[], name: string): Promise<string> {
    if (
      !scopes.length ||
      scopes.length > 32 ||
      scopes.some((scope) => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(scope)) ||
      !name.trim() ||
      name.length > 100
    )
      throw new AccessError('invalid');
    return this.options.access.store.transact((state) => {
      const principal = state.principals.find((item) => item.id === principalId);
      if (!principal) throw new AccessError('invalid');
      const identity = this.principal(state, principal.id, principal.epoch);
      const allowed = this.options.scopesFor(identity);
      if (scopes.some((scope) => !allowed.includes(scope))) throw new AccessError('forbidden');
      const now = this.options.access.now();
      state.deviceTokens = state.deviceTokens.filter(
        (item) => item.expiresAt === null || item.expiresAt > now,
      );
      if (state.deviceTokens.filter((item) => item.principalId === principal.id).length >= this.limit)
        throw new AccessError('rate_limited');
      const raw = this.prefix + newToken();
      state.deviceTokens.push({
        id: tokenHash(raw),
        principalId: principal.id,
        issuerSessionId: null,
        epoch: principal.epoch,
        scopes: [...new Set(scopes)],
        name: name.trim(),
        createdAt: now,
        expiresAt: now + this.ttl,
      });
      return raw;
    });
  }

  authenticateFromState(state: AccessState, token: string, required: readonly string[]): DeviceIdentity {
    const device = state.deviceTokens.find((item) => item.id === tokenHash(token));
    if (!device) throw new AccessError('unauthorized');
    return this.identityFromRecord(state, device, required);
  }

  /** Display status only. A record ID is never a credential or authorization proof. */
  statusFromState(
    state: AccessState,
    id: string,
    required: readonly string[] = [],
  ): 'active' | 'expired' | 'unavailable' {
    const device = state.deviceTokens.find((item) => item.id === id);
    if (!device) return 'unavailable';
    if (device.expiresAt !== null && device.expiresAt <= this.options.access.now()) return 'expired';
    try {
      this.identityFromRecord(state, device, required);
      return 'active';
    } catch (error) {
      if (isAccessError(error) && ['unauthorized', 'forbidden'].includes(error.code)) return 'unavailable';
      throw error;
    }
  }

  private identityFromRecord(
    state: AccessState,
    device: AccessState['deviceTokens'][number],
    required: readonly string[],
  ): DeviceIdentity {
    if (device.expiresAt !== null && device.expiresAt <= this.options.access.now())
      throw new AccessError('unauthorized');
    if (
      device.defaultProfileId &&
      !state.householdProfiles?.some(
        (profile) => profile.id === device.defaultProfileId && profile.epoch === device.defaultProfileEpoch,
      )
    )
      throw new AccessError(
        'unauthorized',
        'The paired profile is no longer available. Pair this device again.',
      );
    const principal = this.principal(state, device.principalId, device.epoch);
    const scopedPrincipal = this.scopedPrincipal(state, principal, device.defaultProfileId);
    const allowed = this.options.scopesFor(scopedPrincipal);
    const scopes = device.scopes.filter((scope) => allowed.includes(scope));
    if (required.some((scope) => !scopes.includes(scope))) throw new AccessError('forbidden');
    return {
      id: device.id,
      principal: scopedPrincipal,
      scopes,
      name: device.name,
      expiresAt: device.expiresAt,
      ...(device.defaultProfileId ? { defaultProfileId: device.defaultProfileId } : {}),
    };
  }

  async list(sessionToken: string): Promise<AccessState['deviceTokens']> {
    const state = await this.options.access.store.read();
    const auth = this.options.access.sessionFromState(state, sessionToken);
    return state.deviceTokens.filter(
      (device) =>
        (device.expiresAt === null || device.expiresAt > this.options.access.now()) &&
        (this.options.access.householdOwnerFromState(state, sessionToken) ||
          (auth.principal
            ? device.principalId === auth.principal.id
            : device.issuerSessionId === auth.session.id)),
    );
  }

  async revoke(sessionToken: string, id: string): Promise<void> {
    await this.options.access.store.transact((state) => {
      const auth = this.options.access.sessionFromState(state, sessionToken);
      const device = state.deviceTokens.find((item) => item.id === id);
      if (!device) return;
      if (
        !this.options.access.householdOwnerFromState(state, sessionToken) &&
        (auth.principal
          ? device.principalId !== auth.principal.id
          : device.issuerSessionId !== auth.session.id)
      )
        throw new AccessError('forbidden');
      state.deviceTokens = state.deviceTokens.filter((item) => item.id !== id);
    });
  }

  private canManageDevices(identity: DeviceIdentity): boolean {
    return (
      identity.principal?.role === 'owner' &&
      this.options.managementScope !== undefined &&
      identity.scopes.includes(this.options.managementScope)
    );
  }

  async listForDevice(
    token: string,
  ): Promise<
    Array<Pick<AccessState['deviceTokens'][number], 'id' | 'name' | 'scopes' | 'createdAt' | 'expiresAt'>>
  > {
    const state = await this.options.access.store.read();
    const identity = this.authenticateFromState(state, token, []);
    const manage = this.canManageDevices(identity);
    return state.deviceTokens
      .filter((device) => manage || device.id === identity.id)
      .map((device) => ({
        id: device.id,
        name: device.name,
        scopes: [...device.scopes],
        createdAt: device.createdAt,
        expiresAt: device.expiresAt,
      }));
  }

  async revokeForDevice(token: string, id: string): Promise<void> {
    await this.options.access.store.transact((state) => {
      const identity = this.authenticateFromState(state, token, []);
      if (id !== identity.id && !this.canManageDevices(identity)) throw new AccessError('forbidden');
      state.deviceTokens = state.deviceTokens.filter((device) => device.id !== id);
    });
  }
}
