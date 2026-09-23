import { AccessVerification } from './AccessVerification';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AccessClient,
  AccessClientError,
  browserSupportsWebAuthn,
  type BrowserPasskey,
  type BrowserSession,
  type BrowserStoredSession,
} from '../../../packages/core/src/access/transport/browser';
import { defaultAccessFormCopy, type AccessFormProps } from './AccessForm';

export interface AccessSecurityCopy {
  title: string;
  verify: string;
  currentPassword: string;
  verifyPassword: string;
  verifyPasskey: string;
  passkeys: string;
  householdPasskeys?: string;
  passkeyName: string;
  addPasskey: string;
  remove: string;
  removeHint: string;
  recovery: string;
  generateCodes: string;
  recoveryHint: string;
  hideCodes: string;
  password: string;
  changePassword: string;
  sessions: string;
  thisSession: string;
  signOut: string;
  signIn: string;
  empty: string;
  working: string;
  completed: string;
  refreshFailed: string;
  passkeyUnavailable: string;
  error(code: string): string;
}
const defaultCopy: AccessSecurityCopy = {
  title: 'Account security',
  verify: 'Verify your identity before changing credentials.',
  currentPassword: 'Current password',
  verifyPassword: 'Verify with password',
  verifyPasskey: 'Verify with passkey',
  passkeys: 'Passkeys',
  householdPasskeys: 'Household passkeys',
  passkeyName: 'Passkey name',
  addPasskey: 'Add passkey',
  remove: 'Remove',
  removeHint: 'Removing a passkey signs you out on all devices.',
  recovery: 'Recovery codes',
  generateCodes: 'Create recovery codes',
  recoveryHint: 'New codes replace all previous codes. Save them somewhere private.',
  hideCodes: 'Hide codes',
  password: 'New password',
  changePassword: 'Change password',
  sessions: 'Sessions',
  thisSession: 'This session',
  signOut: 'Sign out',
  signIn: defaultAccessFormCopy.login,
  empty: 'None yet.',
  working: defaultAccessFormCopy.working,
  completed: 'Saved.',
  refreshFailed:
    'Your change was saved. Account details could not be refreshed. Reload to see the current state.',
  passkeyUnavailable: defaultAccessFormCopy.passkeyUnavailable,
  error: defaultAccessFormCopy.error,
};
export interface AccessSecurityProps {
  endpoint?: string;
  classes?: AccessFormProps['classes'];
  copy?: Partial<AccessSecurityCopy>;
  showRecoveryCodes?: boolean;
  onSignInRequired(): void;
  onHouseholdEntered?(): void;
}

export function AccessSecurity({
  endpoint,
  classes = {},
  copy,
  showRecoveryCodes = true,
  onSignInRequired,
  onHouseholdEntered,
}: AccessSecurityProps) {
  const client = useMemo(() => new AccessClient({ endpoint }), [endpoint]);
  const labels = { ...defaultCopy, ...copy };
  const id = useId();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [householdAdmin, setHouseholdAdmin] = useState(false);
  const [keys, setKeys] = useState<BrowserPasskey[]>([]);
  const [householdKeys, setHouseholdKeys] = useState<BrowserPasskey[]>([]);
  const [sessions, setSessions] = useState<BrowserStoredSession[]>([]);
  const [supportsPasskeys, setSupportsPasskeys] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [householdPassword, setHouseholdPassword] = useState('');
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);
  const active = useRef<AbortController | null>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const current = await client.session(signal).catch((failure: unknown) => {
        if (!signal.aborted && failure instanceof AccessClientError && failure.status === 401)
          setSession(null);
        throw failure;
      });
      const household = !current.principal;
      if (household) await client.mutation('authorize-owner', {}, signal);
      const [capabilities, passkeys, devices, householdPasskeys] = await Promise.all([
        client.capabilities(signal),
        household ? Promise.resolve([]) : client.passkeys(signal),
        client.sessions(signal),
        household || current.principal?.role === 'owner'
          ? client.householdPasskeys(signal)
          : Promise.resolve([]),
      ]);
      signal.throwIfAborted();
      setSession(current);
      setHouseholdAdmin(household);
      setKeys(passkeys);
      setHouseholdKeys(householdPasskeys);
      setSessions(
        household ? devices : devices.filter((device) => device.principalId === current.principal?.id),
      );
      setSupportsPasskeys(capabilities.passkeys && browserSupportsWebAuthn());
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSession(null);
    setHouseholdAdmin(false);
    setKeys([]);
    setHouseholdKeys([]);
    setSessions([]);
    setCodes([]);
    setReplacement('');
    setHouseholdPassword('');
    setBusy(false);
    setLoading(true);
    setName('');
    setSupportsPasskeys(false);
    setError('');
    setCompleted(false);
    void refresh(controller.signal)
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);

  const run = async (operation: (signal: AbortSignal) => Promise<void>, reload = true) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setCompleted(false);
    setCodes([]);
    try {
      await operation(controller.signal);
      if (controller.signal.aborted) return;
      setCompleted(true);
      if (reload) {
        try {
          await refresh(controller.signal);
        } catch {
          if (!controller.signal.aborted) setError('refresh_failed');
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setReplacement('');
        setHouseholdPassword('');
      }
    }
  };

  return (
    <section className={classes.root} aria-busy={busy || loading}>
      <h2>{labels.title}</h2>
      {error && (
        <p className={classes.error} role="alert" tabIndex={-1} ref={errorElement}>
          {error === 'refresh_failed' ? labels.refreshFailed : labels.error(error)}
        </p>
      )}
      {completed && (
        <p role="status" className={classes.hint}>
          {labels.completed}
        </p>
      )}
      {loading ? (
        <p role="status" className={classes.hint}>
          {labels.working}
        </p>
      ) : householdAdmin && session ? (
        <>
          <h3>{labels.householdPasskeys}</h3>
          {householdKeys.length ? (
            <ul>
              {householdKeys.map((key) => (
                <li key={key.id}>
                  {key.name}{' '}
                  <button
                    className={classes.secondary}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async (signal) => {
                        await client.mutation('remove-household-passkey', { id: key.id }, signal);
                      });
                    }}
                  >
                    {labels.remove}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={classes.hint}>{labels.empty}</p>
          )}
          {supportsPasskeys ? (
            <form
              className={classes.form}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async (signal) => {
                  await client.enterHousehold(householdPassword, signal);
                  await client.registerHouseholdPasskey(name, signal);
                  if (!signal.aborted) (onHouseholdEntered ?? onSignInRequired)();
                }, false);
              }}
            >
              <label className={classes.label} htmlFor={`${id}-household-name`}>
                {labels.passkeyName}
              </label>
              <input
                id={`${id}-household-name`}
                className={classes.input}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
                disabled={busy}
              />
              <label className={classes.label} htmlFor={`${id}-household-current`}>
                {labels.currentPassword}
              </label>
              <input
                id={`${id}-household-current`}
                className={classes.input}
                type="password"
                autoComplete="current-password"
                value={householdPassword}
                onChange={(event) => setHouseholdPassword(event.target.value)}
                required
                disabled={busy}
              />
              <button className={classes.button} disabled={busy} type="submit">
                {labels.addPasskey}
              </button>
            </form>
          ) : (
            <p className={classes.hint}>{labels.passkeyUnavailable}</p>
          )}
          <h3>{labels.password}</h3>
          <form
            className={classes.form}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async (signal) => {
                await client.mutation('configure-household', { password: replacement }, signal);
                if (!signal.aborted) onSignInRequired();
              }, false);
            }}
          >
            <label className={classes.label} htmlFor={`${id}-household-new`}>
              {labels.password}
            </label>
            <input
              id={`${id}-household-new`}
              className={classes.input}
              type="password"
              autoComplete="new-password"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              minLength={12}
              required
              disabled={busy}
            />
            <button className={classes.button} disabled={busy} type="submit">
              {labels.changePassword}
            </button>
          </form>
          {showRecoveryCodes && (
            <>
              <h3>{labels.recovery}</h3>
              <p className={classes.hint}>{labels.recoveryHint}</p>
              <button
                className={classes.button}
                disabled={busy}
                type="button"
                onClick={() => {
                  void run(async (signal) => {
                    const generated = await client.recoveryCodes(signal);
                    if (!signal.aborted) setCodes(generated);
                  }, false);
                }}
              >
                {labels.generateCodes}
              </button>
              {codes.length > 0 && (
                <>
                  <ol>
                    {codes.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ol>
                  <button className={classes.secondary} type="button" onClick={() => setCodes([])}>
                    {labels.hideCodes}
                  </button>
                </>
              )}
            </>
          )}
          <h3>{labels.sessions}</h3>
          <ul>
            {sessions.map((device) => (
              <li key={device.id}>
                {device.id === session.sessionId ? labels.thisSession : device.name}{' '}
                <button
                  className={classes.secondary}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void run(async (signal) => {
                      await client.mutation('revoke-session', { id: device.id }, signal);
                      if (device.id === session.sessionId && !signal.aborted) onSignInRequired();
                    }, device.id !== session.sessionId);
                  }}
                >
                  {labels.signOut}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : !session?.principal ? (
        <button type="button" className={classes.button} onClick={onSignInRequired}>
          {labels.signIn}
        </button>
      ) : (
        <>
          <p>{session.principal.name}</p>
          <AccessVerification
            endpoint={endpoint}
            disabled={busy}
            onBusyChange={setBusy}
            onVerified={() => {
              void run(refresh, false);
            }}
            copy={{
              title: labels.verify,
              password: labels.currentPassword,
              verifyPassword: labels.verifyPassword,
              verifyPasskey: labels.verifyPasskey,
              working: labels.working,
              verified: labels.completed,
              error: labels.error,
            }}
            classes={classes}
          />
          <h3>{labels.passkeys}</h3>
          {keys.length ? (
            <ul>
              {keys.map((key) => (
                <li key={key.id}>
                  {key.name}{' '}
                  <button
                    className={classes.secondary}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async (signal) => {
                        await client.mutation('remove-passkey', { id: key.id }, signal);
                        if (!signal.aborted) onSignInRequired();
                      }, false);
                    }}
                  >
                    {labels.remove}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={classes.hint}>{labels.empty}</p>
          )}
          <p className={classes.hint}>{labels.removeHint}</p>
          {supportsPasskeys ? (
            <form
              className={classes.form}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async (signal) => {
                  await client.registerPasskey(name, signal);
                  if (!signal.aborted) setName('');
                });
              }}
            >
              <label className={classes.label} htmlFor={`${id}-name`}>
                {labels.passkeyName}
              </label>
              <input
                id={`${id}-name`}
                className={classes.input}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
                disabled={busy}
              />
              <button className={classes.button} disabled={busy} type="submit">
                {labels.addPasskey}
              </button>
            </form>
          ) : (
            <p className={classes.hint}>{labels.passkeyUnavailable}</p>
          )}
          {session.principal.role === 'owner' && (
            <>
              <h3>{labels.householdPasskeys}</h3>
              {householdKeys.length ? (
                <ul>
                  {householdKeys.map((key) => (
                    <li key={key.id}>
                      {key.name}{' '}
                      <button
                        type="button"
                        className={classes.secondary}
                        disabled={busy}
                        onClick={() => {
                          void run(async (signal) => {
                            await client.mutation('remove-household-passkey', { id: key.id }, signal);
                          });
                        }}
                      >
                        {labels.remove}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={classes.hint}>{labels.empty}</p>
              )}
            </>
          )}
          <h3>{labels.password}</h3>
          <form
            className={classes.form}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async (signal) => {
                await client.changePassword(replacement, signal);
              });
            }}
          >
            <label className={classes.label} htmlFor={`${id}-new`}>
              {labels.password}
            </label>
            <input
              id={`${id}-new`}
              className={classes.input}
              type="password"
              autoComplete="new-password"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              minLength={12}
              required
              disabled={busy}
            />
            <button className={classes.button} disabled={busy} type="submit">
              {labels.changePassword}
            </button>
          </form>
          {showRecoveryCodes && (
            <>
              <h3>{labels.recovery}</h3>
              <p className={classes.hint}>{labels.recoveryHint}</p>
              <button
                className={classes.button}
                disabled={busy}
                type="button"
                onClick={() => {
                  void run(async (signal) => {
                    const generated = await client.recoveryCodes(signal);
                    if (!signal.aborted) setCodes(generated);
                  }, false);
                }}
              >
                {labels.generateCodes}
              </button>
              {codes.length > 0 && (
                <>
                  <ol>
                    {codes.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ol>
                  <button className={classes.secondary} type="button" onClick={() => setCodes([])}>
                    {labels.hideCodes}
                  </button>
                </>
              )}
            </>
          )}
          <h3>{labels.sessions}</h3>
          <ul>
            {sessions.map((device) => (
              <li key={device.id}>
                {device.id === session.sessionId ? labels.thisSession : device.name}{' '}
                <button
                  className={classes.secondary}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void run(async (signal) => {
                      await client.mutation('revoke-session', { id: device.id }, signal);
                      if (device.id === session.sessionId && !signal.aborted) onSignInRequired();
                    }, device.id !== session.sessionId);
                  }}
                >
                  {labels.signOut}
                </button>
              </li>
            ))}
          </ul>
          {busy && (
            <p role="status" className={classes.hint}>
              {labels.working}
            </p>
          )}
        </>
      )}
    </section>
  );
}
