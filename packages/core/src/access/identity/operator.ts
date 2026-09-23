import type { AccessService } from '../core/service';
import type { DeviceService } from '../admission/devices';
import { createInterface } from 'node:readline/promises';

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode || !process.stderr.isTTY)
    throw new Error('Household setup requires an interactive terminal.');
  process.stderr.write(prompt);
  let value = '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const decoder = new TextDecoder();
      const onData = (chunk: Buffer) => {
        for (const character of decoder.decode(chunk, { stream: true })) {
          if (character === '\r' || character === '\n') {
            process.stdin.off('data', onData);
            resolve(value);
            return;
          }
          if (character === '\u0003' || character === '\u001b') {
            process.stdin.off('data', onData);
            reject(new Error('Household setup cancelled.'));
            return;
          }
          if (character === '\u007f') value = Array.from(value).slice(0, -1).join('');
          else if (character >= ' ') value += character;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write('\n');
  }
}

/** Prompt locally without echoing or passing the shared password through process arguments. */
export async function readLocalSetupInput(): Promise<{ name: string; password: string }> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error('Household setup requires an interactive terminal.');
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const name = await terminal.question('First Admin profile name: ');
  terminal.close();
  const password = await hiddenPassword('Shared password: ');
  const confirmation = await hiddenPassword('Confirm shared password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  return { name, password };
}

export async function readLocalResetInput(): Promise<string> {
  const password = await hiddenPassword('New shared password: ');
  const confirmation = await hiddenPassword('Confirm new shared password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  return password;
}

export interface AccessOperatorOptions {
  initialize?: () => Promise<{ warnings?: readonly string[] }>;
  setupInput?: () => Promise<{ name: string; password: string }>;
  resetInput?: () => Promise<string>;
  devices?: { service: DeviceService; scopes: readonly string[] };
}

export function parseAccessCommand(args: readonly string[]) {
  const [operation, principalId, deviceName] = args;
  if (
    !operation ||
    !['list', 'claim', 'recover', 'initialize', 'device', 'setup', 'reset'].includes(operation) ||
    (operation === 'device'
      ? args.length < 2 || args.length > 3 || !principalId
      : args.length !== (operation === 'recover' ? 2 : 1)) ||
    (operation === 'recover' && !principalId)
  )
    throw new Error(
      'Use access list, access setup, access reset, access claim, access recover <principalId>, access device <principalId> [name], or access initialize.',
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
  if (operation === 'setup') {
    if (!options.setupInput) throw new Error('This application does not provide local household setup.');
    const { name, password } = await options.setupInput();
    const code = await access.issueOperatorToken();
    await access.claimOwner(code, name, password, 'household');
    return JSON.stringify({ operation, name });
  }
  if (operation === 'reset') {
    if (!options.resetInput)
      throw new Error('This application does not provide local household password reset.');
    await access.resetHouseholdPasswordForOperator(await options.resetInput());
    return JSON.stringify({ operation });
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
