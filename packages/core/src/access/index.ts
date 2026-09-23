export {
  AccessService,
  AccessError,
  isAccessError,
  newToken,
  tokenHash,
  transitionAccessMode,
} from './core/service';
export type { AccessOptions, AuthenticatedSession } from './core/service';
export { PasskeyService } from './passkey/passkeys';
export { PasskeyManagement } from './passkey/passkey-management';
export { HouseholdProfileService } from './identity/profiles';
export { HouseholdProfileManagement } from './identity/profile-management';
export type {
  ProfileManagerCredential,
  ProfileManagementOptions,
  PreparedProfileCreation,
  PreparedProfileUpdate,
  PreparedProfileRemoval,
} from './identity/profile-management';
export type { HouseholdProfile } from './identity/profiles';
export type { PasskeyOptions } from './passkey/passkeys';
export { accessStateSchema, initialAccessState } from './core/state';
export type { AccessState, Principal, Session, Passkey, Challenge } from './core/state';
export {
  hashPassword,
  hashConfiguredPassword,
  importPasswordHash,
  passwordHashNeedsUpgrade,
  verifyPassword,
  PASSWORD_INPUT_MAX_BYTES,
} from './core/password';
export { DeviceService } from './admission/devices';
export type { DeviceOptions, DeviceIdentity } from './admission/devices';
export { InvitationService } from './admission/invitations';
export { PrincipalManagement, removePrincipalFromState } from './identity/principals';
export type { PrincipalMutation, PreparedPrincipalMutation } from './identity/principals';
export { initializeAccess, initializeHouseholdDevices } from './core/initialization';
export type { InitialAccess, InitialHouseholdDevice } from './core/initialization';
export {
  executeAccessCommand,
  parseAccessCommand,
  readLocalSetupInput,
  readLocalResetInput,
} from './identity/operator';
export type { AccessOperatorOptions } from './identity/operator';
