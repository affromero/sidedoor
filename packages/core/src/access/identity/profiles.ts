import { AccessError, type AccessService } from '../core/service';
import type { AccessState, Principal } from '../core/state';

export interface HouseholdProfile {
  id: string;
  name: string;
}

function selectable(state: AccessState, principal: Principal): boolean {
  return (
    principal.role === 'member' &&
    principal.pendingRole !== 'owner' &&
    principal.passwordHash === null &&
    !state.passkeys.some((key) => key.principalId === principal.id)
  );
}

function availableProfiles(state: AccessState) {
  return state.householdProfiles ?? state.principals.filter((principal) => selectable(state, principal));
}

function selectProfile(
  state: AccessState,
  session: AccessState['sessions'][number],
  profile: { id: string; epoch: number },
) {
  session.selectedProfileId = profile.id;
  session.selectedProfileEpoch = profile.epoch;
  if (state.householdProfiles !== undefined) session.selectedProfileSource = 'explicit';
  else delete session.selectedProfileSource;
}

/** A household profile selects content. It never authenticates a principal. */
export class HouseholdProfileService {
  constructor(private readonly access: AccessService) {}

  async enterOpen(profileId: string, existingToken?: string): Promise<string> {
    return this.access.store.transact((state) => {
      const profile = availableProfiles(state).find((profile) => profile.id === profileId);
      if (!profile) throw new AccessError('forbidden');
      const token = this.access.issueOpenHouseholdSession(state, 'Household browser', existingToken);
      const session = this.household(state, token);
      selectProfile(state, session, profile);
      return token;
    });
  }

  async list(token: string): Promise<HouseholdProfile[]> {
    const state = await this.access.store.read();
    this.household(state, token);
    return availableProfiles(state).map((principal) => ({ id: principal.id, name: principal.name }));
  }

  async select(token: string, profileId: string | null): Promise<void> {
    await this.access.store.transact((state) => {
      const session = this.household(state, token);
      if (profileId === null) {
        delete session.selectedProfileId;
        delete session.selectedProfileEpoch;
        delete session.selectedProfileSource;
        return;
      }
      const profile = availableProfiles(state).find((profile) => profile.id === profileId);
      if (!profile) throw new AccessError('forbidden');
      selectProfile(state, session, profile);
    });
  }

  async selected(token: string): Promise<HouseholdProfile | null> {
    const state = await this.access.store.read();
    return this.selectedFromState(state, token);
  }

  selectedFromState(state: AccessState, token: string): HouseholdProfile | null {
    const session = this.household(state, token);
    const profile = availableProfiles(state).find((profile) => profile.id === session.selectedProfileId);
    if (
      !profile ||
      profile.epoch !== session.selectedProfileEpoch ||
      (state.householdProfiles !== undefined) !== (session.selectedProfileSource === 'explicit')
    )
      return null;
    return { id: profile.id, name: profile.name };
  }

  private household(state: AccessState, token: string) {
    const auth = this.access.sessionFromState(state, token);
    if (state.mode !== 'household' || auth.principal !== null) throw new AccessError('forbidden');
    return auth.session;
  }
}
