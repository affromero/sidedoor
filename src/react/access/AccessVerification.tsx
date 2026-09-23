import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import {
  AccessClient,
  AccessClientError,
  type BrowserSession,
} from '../../../packages/core/src/access/transport/browser';

export interface AccessVerificationProps {
  endpoint?: string;
  disabled?: boolean;
  onVerified?(session: BrowserSession): void;
  onBusyChange?(busy: boolean): void;
  copy?: Partial<{
    title: string;
    password: string;
    verifyPassword: string;
    verifyPasskey: string;
    working: string;
    verified: string;
    error(code: string): string;
  }>;
  classes?: Partial<Record<'form' | 'label' | 'input' | 'button' | 'secondary' | 'hint' | 'error', string>>;
}

/** Refresh account verification in place without discarding an unfinished configuration form. */
export function AccessVerification({
  endpoint,
  disabled,
  onVerified,
  onBusyChange,
  copy,
  classes = {},
}: AccessVerificationProps) {
  const client = useMemo(() => new AccessClient({ endpoint }), [endpoint]);
  const id = useId();
  const labels = {
    title: 'Verify your identity before changing credentials.',
    password: 'Current password',
    verifyPassword: 'Verify with password',
    verifyPasskey: 'Verify with passkey',
    working: 'Please wait…',
    verified: 'Identity verified',
    error: (code: string) =>
      code === 'outcome_unknown'
        ? 'Verification may have completed. Check your session before trying again.'
        : 'Verification failed. Please try again.',
    ...copy,
  };
  const [password, setPassword] = useState('');
  const [passkeys, setPasskeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [householdAdmin, setHouseholdAdmin] = useState(false);
  const active = useRef<AbortController | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const busyChange = useRef(onBusyChange);
  useEffect(() => {
    busyChange.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    const controller = new AbortController();
    setPassword('');
    setPasskeys(false);
    setError('');
    setVerified(false);
    setHouseholdAdmin(false);
    setBusy(false);
    void client
      .session(controller.signal)
      .then(async (session) => {
        if (session.principal || controller.signal.aborted) return;
        await client.mutation('authorize-owner', {}, controller.signal);
        if (!controller.signal.aborted) setHouseholdAdmin(true);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
      });
    void client
      .capabilities(controller.signal)
      .then((capabilities) => {
        if (!controller.signal.aborted) setPasskeys(capabilities.passkeys && browserSupportsWebAuthn());
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
      });
    return () => {
      controller.abort();
      active.current?.abort();
      active.current = null;
      busyChange.current?.(false);
    };
  }, [client]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  const verify = async (method: 'password' | 'passkey') => {
    if (active.current || disabled) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    busyChange.current?.(true);
    setError('');
    setVerified(false);
    let session: BrowserSession | undefined;
    try {
      session =
        method === 'password'
          ? await client.reauthenticatePassword(password, controller.signal)
          : await client.reauthenticatePasskey(controller.signal);
      if (!controller.signal.aborted) setVerified(true);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof AccessClientError ? failure.code : 'request_failed');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setPassword('');
        busyChange.current?.(false);
      }
    }
    if (session && !controller.signal.aborted) onVerified?.(session);
  };
  if (householdAdmin)
    return (
      <p role="status" className={classes.hint}>
        {labels.verified}
      </p>
    );
  return (
    <form
      className={classes.form}
      aria-label={labels.title}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void verify('password');
      }}
    >
      <p className={classes.hint}>{labels.title}</p>
      <label className={classes.label} htmlFor={`${id}-password`}>
        {labels.password}
      </label>
      <input
        className={classes.input}
        id={`${id}-password`}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        disabled={busy || disabled}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button className={classes.button} disabled={busy || disabled} type="submit">
        {busy ? labels.working : labels.verifyPassword}
      </button>
      {passkeys && (
        <button
          className={classes.secondary}
          disabled={busy || disabled}
          type="button"
          onClick={() => {
            void verify('passkey');
          }}
        >
          {labels.verifyPasskey}
        </button>
      )}
      {verified && (
        <p role="status" className={classes.hint}>
          {labels.verified}
        </p>
      )}
      {error && (
        <p className={classes.error} role="alert" tabIndex={-1} ref={alert}>
          {labels.error(error)}
        </p>
      )}
    </form>
  );
}
