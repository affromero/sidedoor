import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AccessError, AccessService, newToken, tokenHash } from '../core/service';
import type { Challenge, Passkey } from '../core/state';
import { PasskeyManagement } from './passkey-management';

export interface PasskeyOptions {
  access: AccessService;
  origin: string;
  name: string;
}

function sameChallenge(left: Challenge, right: Challenge): boolean {
  return (
    left.id === right.id &&
    left.challenge === right.challenge &&
    left.kind === right.kind &&
    left.principalId === right.principalId &&
    left.sessionId === right.sessionId &&
    left.originalSessionId === right.originalSessionId &&
    left.principalEpoch === right.principalEpoch &&
    left.rpId === right.rpId &&
    left.origin === right.origin &&
    left.expiresAt === right.expiresAt
  );
}

/** One exact canonical origin. Parent-domain RP widening is deliberately not inferred. */
export class PasskeyService extends PasskeyManagement {
  private readonly origin: string;
  private readonly rpId: string;
  private readonly name: string;

  constructor(options: PasskeyOptions) {
    super(options.access);
    this.name = options.name;
    const origin = new URL(options.origin);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new AccessError('invalid');
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost'))
      throw new AccessError('invalid');
    this.origin = origin.origin;
    this.rpId = origin.hostname;
  }

  private checkOrigin(origin: string): void {
    if (origin !== this.origin) throw new AccessError('forbidden');
  }

  async registrationOptions(token: string, origin: string) {
    this.checkOrigin(origin);
    const state = await this.access.store.read();
    const { principal, session } = this.access.sessionFromState(state, token, false, true);
    if (!principal) throw new AccessError('forbidden');
    const options = await generateRegistrationOptions({
      rpName: this.name,
      rpID: this.rpId,
      userID: new TextEncoder().encode(principal.id),
      userName: principal.name,
      attestationType: 'none',
      excludeCredentials: state.passkeys
        .filter((key) => key.principalId === principal.id)
        .map((key) => ({ id: key.id, transports: key.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const ceremony = newToken();
    await this.access.store.transact((current) => {
      this.access.sessionFromState(current, token, false, true);
      current.challenges = current.challenges.filter(
        (item) => item.expiresAt > this.access.now() && item.sessionId !== session.id,
      );
      current.challenges.push({
        id: tokenHash(ceremony),
        challenge: options.challenge,
        kind: 'register',
        principalId: principal.id,
        sessionId: session.id,
        rpId: this.rpId,
        origin,
        expiresAt: this.access.now() + 5 * 60 * 1000,
      });
    });
    return { ceremony, options };
  }

  private async consume(
    ceremony: string,
    binding: string,
    origin: string,
    kind: Challenge['kind'],
  ): Promise<Challenge> {
    this.checkOrigin(origin);
    return this.access.store.transact((state) => {
      const challenge = state.challenges.find((item) => item.id === tokenHash(ceremony));
      if (
        !challenge ||
        challenge.expiresAt <= this.access.now() ||
        challenge.kind !== kind ||
        challenge.origin !== origin ||
        challenge.rpId !== this.rpId ||
        challenge.sessionId !== tokenHash(binding)
      )
        throw new AccessError('unauthorized');
      state.challenges = state.challenges.filter((item) => item.id !== challenge.id);
      return challenge;
    });
  }

  async register(
    token: string,
    ceremony: string,
    response: RegistrationResponseJSON,
    name: string,
    origin: string,
  ): Promise<void> {
    await this.access.authenticate(token, false, true);
    const challenge = await this.consume(ceremony, token, origin, 'register');
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    });
    if (!result.verified) throw new AccessError('unauthorized');
    const info = result.registrationInfo;
    await this.access.store.transact((state) => {
      const { principal } = this.access.sessionFromState(state, token, false, true);
      if (!principal || principal.id !== challenge.principalId) throw new AccessError('forbidden');
      if (state.passkeys.some((key) => key.id === info.credential.id)) throw new AccessError('conflict');
      state.passkeys.push({
        id: info.credential.id,
        principalId: principal.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        name: name.trim().slice(0, 100) || 'Passkey',
        createdAt: this.access.now(),
        backedUp: info.credentialBackedUp,
      });
    });
  }

  /** Binding is a fresh server-generated, HttpOnly ceremony cookie maintained by the HTTP adapter. */
  async authenticationOptions(binding: string, origin: string) {
    return this.authenticationOptionsFor(binding, origin);
  }

  async reauthenticationOptions(token: string, binding: string, origin: string) {
    return this.authenticationOptionsFor(binding, origin, token);
  }

  private async authenticationOptionsFor(binding: string, origin: string, originalToken?: string) {
    this.checkOrigin(origin);
    if (binding.length < 32 || binding.length > 128) throw new AccessError('invalid');
    let allowCredentials: Pick<Passkey, 'id' | 'transports'>[] | undefined;
    if (originalToken !== undefined) {
      const state = await this.access.store.read();
      const auth = this.access.sessionFromState(state, originalToken);
      if (!auth.principal) throw new AccessError('forbidden');
      allowCredentials = state.passkeys
        .filter((key) => key.principalId === auth.principal?.id)
        .map((key) => ({ id: key.id, transports: key.transports }));
      if (!allowCredentials.length) throw new AccessError('invalid');
    }
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: 'required',
      allowCredentials,
    });
    const ceremony = newToken();
    await this.access.store.transact((state) => {
      state.challenges = state.challenges.filter(
        (item) => item.expiresAt > this.access.now() && item.sessionId !== tokenHash(binding),
      );
      if (state.challenges.length >= 1000) throw new AccessError('rate_limited');
      const auth = originalToken === undefined ? null : this.access.sessionFromState(state, originalToken);
      if (auth && !auth.principal) throw new AccessError('forbidden');
      state.challenges.push({
        id: tokenHash(ceremony),
        challenge: options.challenge,
        kind: auth ? 'reauthenticate' : 'authenticate',
        principalId: auth?.principal?.id ?? null,
        originalSessionId: auth?.session.id,
        principalEpoch: auth?.principal?.epoch,
        sessionId: tokenHash(binding),
        rpId: this.rpId,
        origin,
        expiresAt: this.access.now() + 5 * 60 * 1000,
      });
    });
    return { ceremony, options };
  }

  async login(
    binding: string,
    ceremony: string,
    response: AuthenticationResponseJSON,
    origin: string,
    name = 'Passkey browser',
  ): Promise<string> {
    return this.completeAuthentication(binding, ceremony, response, origin, name);
  }

  async reauthenticate(
    token: string,
    binding: string,
    ceremony: string,
    response: AuthenticationResponseJSON,
    origin: string,
  ): Promise<string> {
    return this.completeAuthentication(binding, ceremony, response, origin, 'Passkey browser', token);
  }

  private async completeAuthentication(
    binding: string,
    ceremony: string,
    response: AuthenticationResponseJSON,
    origin: string,
    name: string,
    originalToken?: string,
  ): Promise<string> {
    this.checkOrigin(origin);
    const snapshot = await this.access.store.read();
    const challenge = snapshot.challenges.find((item) => item.id === tokenHash(ceremony));
    const kind = originalToken === undefined ? 'authenticate' : 'reauthenticate';
    if (
      !challenge ||
      challenge.kind !== kind ||
      challenge.expiresAt <= this.access.now() ||
      challenge.sessionId !== tokenHash(binding) ||
      challenge.origin !== origin ||
      challenge.rpId !== this.rpId
    )
      throw new AccessError('unauthorized');
    const key = snapshot.passkeys.find((item) => item.id === response.id);
    const principal = snapshot.principals.find((item) => item.id === key?.principalId);
    if (!key || !principal) throw new AccessError('unauthorized');
    if (originalToken !== undefined) {
      const auth = this.access.sessionFromState(snapshot, originalToken);
      if (
        challenge.originalSessionId !== auth.session.id ||
        challenge.principalId !== principal.id ||
        auth.principal?.id !== principal.id ||
        challenge.principalEpoch !== principal.epoch
      )
        throw new AccessError('unauthorized');
    }
    if (
      response.response.userHandle &&
      response.response.userHandle !== Buffer.from(principal.id).toString('base64url')
    )
      throw new AccessError('unauthorized');
    await this.access.store.transact((state) => {
      const pending = state.challenges.find((item) => item.id === challenge.id);
      if (!pending || !sameChallenge(pending, challenge) || pending.expiresAt <= this.access.now())
        throw new AccessError('unauthorized');
      if ((pending.verificationAttempts ?? 0) >= 5) throw new AccessError('rate_limited');
      pending.verificationAttempts = (pending.verificationAttempts ?? 0) + 1;
    });
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      credential: {
        id: key.id,
        publicKey: Buffer.from(key.publicKey, 'base64url'),
        counter: key.counter,
        transports: key.transports,
      },
    });
    if (!result.verified) throw new AccessError('unauthorized');
    return this.access.store.transact((state) => {
      const pending = state.challenges.find((item) => item.id === challenge.id);
      if (!pending || pending.expiresAt <= this.access.now() || !sameChallenge(pending, challenge))
        throw new AccessError('unauthorized');
      if (originalToken !== undefined) {
        const auth = this.access.sessionFromState(state, originalToken);
        if (
          auth.session.id !== challenge.originalSessionId ||
          auth.principal?.id !== principal.id ||
          auth.principal.epoch !== challenge.principalEpoch
        )
          throw new AccessError('unauthorized');
        state.sessions = state.sessions.filter((session) => session.id !== auth.session.id);
      }
      const current = state.passkeys.find((item) => item.id === key.id);
      const currentPrincipal = state.principals.find((item) => item.id === principal.id);
      if (
        !current ||
        current.counter !== key.counter ||
        current.publicKey !== key.publicKey ||
        currentPrincipal?.epoch !== principal.epoch
      )
        throw new AccessError('unauthorized');
      current.counter = result.authenticationInfo.newCounter;
      current.backedUp = result.authenticationInfo.credentialBackedUp;
      state.challenges = state.challenges.filter((item) => item.id !== challenge.id);
      return this.access.issueSession(state, principal.id, name);
    });
  }
}
