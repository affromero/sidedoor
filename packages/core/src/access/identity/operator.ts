import type { AccessService } from '../core/service';
import type { DeviceService } from '../admission/devices';

export interface AccessOperatorOptions {
  initialize?: () => Promise<{ warnings?: readonly string[] }>;
  devices?: { service: DeviceService; scopes: readonly string[] };
}

export function parseAccessCommand(args: readonly string[]) {
  const [operation, principalId, deviceName] = args;
  if (
    !operation ||
    !['list', 'claim', 'recover', 'initialize', 'device'].includes(operation) ||
    (operation === 'device'
      ? args.length < 2 || args.length > 3 || !principalId
      : args.length !== (operation === 'recover' ? 2 : 1)) ||
    (operation === 'recover' && !principalId)
  )
    throw new Error(
      'Use access list, access claim, access recover <principalId>, access device <principalId> [name], or access initialize.',
    );
  return { operation, principalId, deviceName };
}

/** Local commands only. Claim and recovery output contains a short-lived bearer credential. */
export async function executeAccessCommand(
  access: AccessService,
  args: readonly string[],
  options: AccessOperatorOptions = {},
): Promise<string> {
  const { operation, principalId, deviceName } = parseAccessCommand(args);
  if (operation === 'initialize') {
    if (!options.initialize)
      throw new Error('This application does not provide a local access initialization command.');
    const result = await options.initialize();
    return JSON.stringify({ operation, warnings: result.warnings ?? [] });
  }
  if (operation === 'list') {
    const state = await access.store.read();
    return JSON.stringify(
      {
        mode: state.mode,
        principals: state.principals.map((principal) => ({
          id: principal.id,
          name: principal.name,
          role: principal.role,
          pendingRole: principal.pendingRole ?? null,
        })),
      },
      null,
      2,
    );
  }
  if (operation === 'device') {
    if (!options.devices) throw new Error('This application does not provide local device credentials.');
    const token = await options.devices.service.issueForOperator(
      principalId!,
      options.devices.scopes,
      deviceName ?? 'Local automation',
    );
    return JSON.stringify({
      operation,
      token,
      expiresAt: (await options.devices.service.authenticate(token, [])).expiresAt,
    });
  }
  const code = await access.issueOperatorToken(principalId);
  return JSON.stringify({ operation, code, expiresInMinutes: 15 });
}
