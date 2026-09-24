import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AccessClient,
  AccessClientError,
  browserSupportsWebAuthn,
  type BrowserSession,
} from '../../../packages/core/src/access/transport/browser';

export type AccessFormMode = 'login' | 'household' | 'claim' | 'recover';
const accessModeDescriptions: Record<AccessFormMode, string> = {
  login: 'Use your personal account name and password.',
  household: 'Use the shared password, then choose a profile.',
  claim: 'Set up a new instance with its owner-claim code.',
  recover: 'Reset access with a recovery code.',
};
export interface AccessFormCopy {
  login: string;
  household: string;
  claim: string;
  recover: string;
  name: string;
  householdAccountLabel?: string;
  householdAccount?: string;
  password: string;
  code: string;
  passkey: string;
  savePasskey?: string;
  savePasskeyHint?: string;
  continueWithoutPasskey?: string;
  working: string;
  newPasswordHint: string;
  mode: string;
  householdMode: string;
  individualMode: string;
  passkeyUnavailable: string;
  error(code: string): string;
}
export const defaultAccessFormCopy: AccessFormCopy = {
  login: 'Sign in',
  household: 'Continue',
  claim: 'Claim instance',
  recover: 'Recover account',
  name: 'Account name',
  householdAccountLabel: 'Shared account',
  householdAccount: 'App access',
  password: 'Password',
  code: 'Recovery or owner-claim code',
  passkey: 'Sign in with a passkey',
  savePasskey: 'Use a passkey next time',
  savePasskeyHint:
    'Save a passkey with your device or password manager so you can open the app without typing its password next time.',
  continueWithoutPasskey: 'Continue without a passkey',
  working: 'Please wait…',
  newPasswordHint: 'Use at least 12 characters.',
  mode: 'Access mode',
  householdMode: 'One shared password',
  individualMode: 'Individual accounts',
  passkeyUnavailable: 'Passkeys require this instance’s configured secure address and a compatible browser.',
  error: (code) =>
    ({
      unauthorized: 'The credentials could not be verified.',
      forbidden: 'This action is not allowed.',
      conflict: 'The account or instance configuration changed. Check its current state before continuing.',
      rate_limited: 'Too many attempts. Try again later.',
      cancelled: 'The passkey prompt was cancelled.',
      passkey_failed: 'The passkey could not be used. Try again or continue with the password.',
      ceremony_busy: 'A passkey prompt is already open.',
      outcome_unknown: 'The request may have completed. Check whether you can sign in before trying again.',
      network_error: 'Could not reach the instance. Check your connection.',
      invalid_password: 'Use at least 12 characters and no more than 1024 UTF-8 bytes.',
    })[code] ?? 'The request could not be completed.',
};
export interface AccessFormProps {
  endpoint?: string;
  initialMode?: AccessFormMode;
  modes?: AccessFormMode[];
  claimModes?: Array<'household' | 'individual'>;
  copy?: Partial<AccessFormCopy>;
  modeDescriptions?: Partial<Record<AccessFormMode, string>>;
  classes?: Partial<
    Record<
      | 'root'
      | 'form'
      | 'navigation'
      | 'modeDescription'
      | 'label'
      | 'input'
      | 'button'
      | 'secondary'
      | 'error'
      | 'hint',
      string
    >
  >;
  onSignedIn(session: BrowserSession): void;
}

/** Shared behavior and accessible markup. The host supplies its own styles, copy and navigation. */
export function AccessForm({
  endpoint,
  initialMode = 'login',
  modes = ['login', 'household', 'recover', 'claim'],
  claimModes = ['household', 'individual'],
  copy,
  modeDescriptions,
  classes = {},
  onSignedIn,
}: AccessFormProps) {
  const client = useMemo(() => new AccessClient({ endpoint }), [endpoint]);
  const labels = { ...defaultAccessFormCopy, ...copy };
  const descriptions = { ...accessModeDescriptions, ...modeDescriptions };
  const id = useId();
  const [selectedMode, setMode] = useState(initialMode);
  if (!modes.length) throw new Error('AccessForm requires at least one permitted mode');
  if (!claimModes.length) throw new Error('AccessForm requires at least one claim mode');
  const mode = modes.includes(selectedMode) ? selectedMode : modes[0]!;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [accessMode, setAccessMode] = useState<'household' | 'individual'>(claimModes[0]!);
  const claimMode = claimModes.includes(accessMode) ? accessMode : claimModes[0]!;
  const [passkeys, setPasskeys] = useState(false);
  const [householdPasskeys, setHouseholdPasskeys] = useState(false);
  const [pendingSession, setPendingSession] = useState<BrowserSession | null>(null);
  const [openHousehold, setOpenHousehold] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const capabilitiesPending = useRef<Promise<void>>(Promise.resolve());
  const supportsPasskeys = useRef(false);
  const errorElement = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setBusy(false);
    setPassword('');
    setCode('');
    setError('');
    setOpenHousehold(false);
    setPasskeys(false);
    setHouseholdPasskeys(false);
    supportsPasskeys.current = false;
    setPendingSession(null);
    const controller = new AbortController();
    capabilitiesPending.current = client
      .capabilities(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          supportsPasskeys.current = result.passkeys && browserSupportsWebAuthn();
          setPasskeys(supportsPasskeys.current);
          setHouseholdPasskeys(result.householdPasskeys === true && browserSupportsWebAuthn());
          setOpenHousehold(result.openHousehold === true);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof AccessClientError ? failure.code : 'network_error');
      });
    return () => {
      controller.abort();
      active.current?.abort();
      active.current = null;
    };
  }, [client, mode]);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);

  const submit = async (passkey = false) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    let session: BrowserSession | undefined;
    try {
      if (passkey)
        session =
          mode === 'household'
            ? await client.authenticateHouseholdPasskey(controller.signal)
            : await client.authenticatePasskey(controller.signal);
      else if (mode === 'login') session = await client.login(name, password, controller.signal);
      else if (mode === 'household')
        session = openHousehold
          ? await client.enterOpenHousehold(controller.signal)
          : await client.enterHousehold(password, controller.signal);
      else if (mode === 'claim')
        session = await client.claim(code, name, password, claimMode, controller.signal);
      else session = await client.recover(code, password, controller.signal);
      if (!controller.signal.aborted) {
        setPassword('');
        setCode('');
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
    if (session && !controller.signal.aborted) {
      const canEnrollHousehold =
        !passkey &&
        ((mode === 'household' && !openHousehold) ||
          (mode === 'claim' && claimMode === 'household') ||
          (mode === 'recover' && session.principal === null));
      if (canEnrollHousehold) await capabilitiesPending.current;
      if (canEnrollHousehold && supportsPasskeys.current) setPendingSession(session);
      else onSignedIn(session);
    }
  };
  const enrollHouseholdPasskey = async () => {
    if (!pendingSession || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      await client.registerHouseholdPasskey('This device', controller.signal);
      if (!controller.signal.aborted) onSignedIn(pendingSession);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const creating = mode === 'claim' || mode === 'recover';

  if (pendingSession)
    return (
      <section className={classes.root} aria-busy={busy}>
        <div className={classes.form}>
          <p className={classes.hint}>{labels.savePasskeyHint}</p>
          <button
            type="button"
            className={classes.button}
            disabled={busy}
            onClick={() => {
              void enrollHouseholdPasskey();
            }}
          >
            {busy ? labels.working : labels.savePasskey}
          </button>
          <button
            type="button"
            className={classes.secondary}
            disabled={busy}
            onClick={() => onSignedIn(pendingSession)}
          >
            {labels.continueWithoutPasskey}
          </button>
          {error && (
            <p className={classes.error} role="alert" tabIndex={-1} ref={errorElement}>
              {labels.error(error)}
            </p>
          )}
        </div>
      </section>
    );

  return (
    <section className={classes.root} aria-busy={busy}>
      {modes.length > 1 && (
        <nav className={classes.navigation} aria-label={labels.mode}>
          {modes.map((value) => (
            <button
              key={value}
              type="button"
              className={classes.secondary}
              aria-label={labels[value]}
              aria-pressed={mode === value}
              aria-describedby={`${id}-${value}-description`}
              title={descriptions[value]}
              disabled={busy}
              onClick={() => {
                setMode(value);
                setPassword('');
                setCode('');
                setError('');
              }}
            >
              {labels[value]}
              <span id={`${id}-${value}-description`} className={classes.modeDescription}>
                {descriptions[value]}
              </span>
            </button>
          ))}
        </nav>
      )}
      <form
        className={classes.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === 'household' && !openHousehold && (
          <input
            type="text"
            name="username"
            value={labels.householdAccount ?? 'App access'}
            autoComplete="username"
            readOnly
            hidden
          />
        )}
        {(mode === 'login' || mode === 'claim') && (
          <>
            <label className={classes.label} htmlFor={`${id}-name`}>
              {labels.name}
            </label>
            <input
              id={`${id}-name`}
              className={classes.input}
              name="username"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={100}
              disabled={busy}
            />
          </>
        )}
        {creating && (
          <>
            <label className={classes.label} htmlFor={`${id}-code`}>
              {labels.code}
            </label>
            <input
              id={`${id}-code`}
              className={classes.input}
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              disabled={busy}
            />
          </>
        )}
        {!(mode === 'household' && openHousehold) && (
          <>
            <label className={classes.label} htmlFor={`${id}-password`}>
              {labels.password}
            </label>
            <input
              id={`${id}-password`}
              className={classes.input}
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={creating ? 'new-password' : 'current-password'}
              required
              minLength={creating ? 12 : undefined}
              disabled={busy}
              aria-describedby={creating ? `${id}-hint` : undefined}
            />
          </>
        )}
        {creating && (
          <p id={`${id}-hint`} className={classes.hint}>
            {labels.newPasswordHint}
          </p>
        )}
        {mode === 'claim' && claimModes.length > 1 && (
          <>
            <label className={classes.label} htmlFor={`${id}-mode`}>
              {labels.mode}
            </label>
            <select
              id={`${id}-mode`}
              className={classes.input}
              value={claimMode}
              onChange={(event) =>
                setAccessMode(event.target.value === 'individual' ? 'individual' : 'household')
              }
              disabled={busy}
            >
              {claimModes.map((value) => (
                <option key={value} value={value}>
                  {value === 'household' ? labels.householdMode : labels.individualMode}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="submit" className={classes.button} disabled={busy}>
          {busy ? labels.working : labels[mode]}
        </button>
        {(mode === 'login' || mode === 'household') &&
          ((mode === 'login' ? passkeys : householdPasskeys) ? (
            <button
              type="button"
              className={classes.secondary}
              disabled={busy}
              onClick={() => {
                void submit(true);
              }}
            >
              {labels.passkey}
            </button>
          ) : mode === 'login' ? (
            <p className={classes.hint}>{labels.passkeyUnavailable}</p>
          ) : null)}
        {error && (
          <p className={classes.error} role="alert" tabIndex={-1} ref={errorElement}>
            {labels.error(error)}
          </p>
        )}
      </form>
    </section>
  );
}
