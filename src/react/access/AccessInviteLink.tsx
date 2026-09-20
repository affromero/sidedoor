import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessClient, AccessClientError } from '../../../packages/core/src/access/transport/browser';
import { AccessVerification } from './AccessVerification';
import { QrCode } from '../connectivity/QrCode';
import type { AccessFormProps } from './AccessForm';

export interface AccessInviteLinkProps {
  endpoint?: string;
  invitationPath?: string;
  classes?: AccessFormProps['classes'];
}

/** Issue secrets only after an explicit owner action and keep them out of URL query logs. */
export function AccessInviteLink({
  endpoint,
  invitationPath = '/invite',
  classes = {},
}: AccessInviteLinkProps) {
  const client = useMemo(() => new AccessClient({ endpoint }), [endpoint]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verify, setVerify] = useState(false);
  const [reusable, setReusable] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setLink('');
    setError('');
    setBusy(false);
    return () => {
      active.current?.abort();
    };
  }, [client, invitationPath]);

  async function issue() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setLink('');
    try {
      const result = await client.request<{ code: string; origin: string; mode: string }>(
        'issue-invitation',
        { ttlMs: 7 * 24 * 60 * 60 * 1000, uses: reusable ? null : 1 },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        typeof result.code !== 'string' ||
        !result.code ||
        !['household', 'individual'].includes(result.mode)
      )
        throw new Error('Invalid invitation response');
      const origin = new URL(result.origin);
      const url = new URL(invitationPath, origin);
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        url.origin !== origin.origin ||
        url.username ||
        url.password
      )
        throw new Error('Invalid invitation destination');
      url.search = '';
      url.hash = new URLSearchParams({ invite: result.code, mode: result.mode }).toString();
      setLink(url.href);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof AccessClientError && failure.code === 'forbidden') setVerify(true);
      setError(
        failure instanceof AccessClientError && failure.code === 'outcome_unknown'
          ? 'The invitation may have been created, but its link was not received. Check your invitations before creating another.'
          : 'The invitation could not be created. Verify your identity and try again.',
      );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section>
      <p className={classes.hint}>Create a link that expires in seven days.</p>
      <label className={classes.label}>
        <input
          type="checkbox"
          checked={reusable}
          disabled={busy}
          onChange={(event) => setReusable(event.target.checked)}
        />{' '}
        Allow multiple people to use this invitation
      </label>
      <button className={classes.button} type="button" disabled={busy} onClick={() => void issue()}>
        {busy ? 'Creating invitation…' : 'Create invitation'}
      </button>
      {verify && (
        <AccessVerification
          endpoint={endpoint}
          classes={classes}
          onVerified={() => {
            setVerify(false);
            setError('');
          }}
        />
      )}
      {error && (
        <p className={classes.error} role="alert">
          {error}
        </p>
      )}
      {link && (
        <div>
          <label className={classes.label}>
            Invitation link
            <input
              className={classes.input}
              readOnly
              value={link}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <QrCode value={link} />
        </div>
      )}
    </section>
  );
}
