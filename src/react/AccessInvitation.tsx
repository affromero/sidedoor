import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AccessClient, AccessClientError, type BrowserSession } from '../../packages/core/src/access/browser';

export interface AccessInvitationProps {
  endpoint?: string;
  copy?: Partial<{
    title: string;
    code: string;
    individual: string;
    name: string;
    password: string;
    submit: string;
    working: string;
    hint: string;
    error(code: string): string;
  }>;
  classes?: Partial<Record<'form' | 'label' | 'input' | 'button' | 'error' | 'hint', string>>;
  onSignedIn(session: BrowserSession): void;
}

/** Invitation secrets remain in a fragment until captured and removed from browser history. */
export function AccessInvitation({ endpoint, copy, classes = {}, onSignedIn }: AccessInvitationProps) {
  const client = useMemo(() => new AccessClient({ endpoint }), [endpoint]);
  const id = useId();
  const labels = {
    title: 'Accept invitation',
    code: 'Invitation code',
    individual: 'Create an individual account',
    name: 'Account name',
    password: 'New password',
    submit: 'Accept invitation',
    working: 'Please wait…',
    hint: 'Use at least 12 characters.',
    error: (code: string) =>
      code === 'outcome_unknown'
        ? 'The invitation may have been accepted. Check whether you are signed in before trying again.'
        : 'The invitation could not be accepted. Check the code and try again.',
    ...copy,
  };
  const [code, setCode] = useState('');
  const [individual, setIndividual] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const previousClient = useRef(client);
  const errorElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (previousClient.current !== client) {
      setCode('');
      setPassword('');
      setName('');
      setIndividual(false);
      setBusy(false);
      setError('');
      previousClient.current = client;
    }
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const invitation = fragment.get('invite');
    if (invitation) {
      setCode(invitation);
      setIndividual(fragment.get('mode') === 'individual');
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [client]);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);
  const submit = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    let session: BrowserSession | undefined;
    try {
      session = await client.redeemInvitation(
        code,
        individual ? { name, password } : undefined,
        controller.signal,
      );
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
    if (session && !controller.signal.aborted) onSignedIn(session);
  };
  return (
    <form
      className={classes.form}
      aria-label={labels.title}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className={classes.label} htmlFor={`${id}-code`}>
        {labels.code}
      </label>
      <input
        id={`${id}-code`}
        className={classes.input}
        type="password"
        autoComplete="off"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        disabled={busy}
        required
      />
      <label className={classes.label} htmlFor={`${id}-individual`}>
        <input
          id={`${id}-individual`}
          type="checkbox"
          checked={individual}
          disabled={busy}
          onChange={(event) => {
            setIndividual(event.target.checked);
            setPassword('');
          }}
        />
        {labels.individual}
      </label>
      {individual && (
        <>
          <label className={classes.label} htmlFor={`${id}-name`}>
            {labels.name}
          </label>
          <input
            id={`${id}-name`}
            className={classes.input}
            autoComplete="username"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            maxLength={100}
            required
          />
          <label className={classes.label} htmlFor={`${id}-password`}>
            {labels.password}
          </label>
          <input
            id={`${id}-password`}
            className={classes.input}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            minLength={12}
            required
          />
          <p className={classes.hint}>{labels.hint}</p>
        </>
      )}
      <button className={classes.button} disabled={busy} type="submit">
        {busy ? labels.working : labels.submit}
      </button>
      {error && (
        <p className={classes.error} ref={errorElement} role="alert" tabIndex={-1}>
          {labels.error(error)}
        </p>
      )}
    </form>
  );
}
