import { useId } from 'react';
import type { ProviderDescriptor } from '../../packages/core/src/ai/browser';

export type ProviderFieldsPatch = Record<string, string | number | boolean | null>;
export interface ProviderFieldStatus {
  id: string;
  configured: boolean;
  source: 'stored' | 'unset';
  value?: string | number | boolean;
  error?: 'endpoint_binding_mismatch';
}
export interface ProviderFieldsProps {
  descriptor: ProviderDescriptor;
  fields?: readonly ProviderFieldStatus[];
  patch: ProviderFieldsPatch;
  onChange(patch: ProviderFieldsPatch): void;
  disabled?: boolean;
  error?: boolean;
  reset?: boolean;
  onResetChange?(reset: boolean): void;
  copy?: Partial<{
    stored: string;
    unset: string;
    unchanged: string;
    clear: string;
    unavailable: string;
    reset: string;
    endpointMismatch: string;
    label(id: string, fallback: string): string;
  }>;
  classes?: Partial<Record<'root' | 'field' | 'label' | 'input' | 'button' | 'hint' | 'error', string>>;
}

/** Descriptor-driven fields keep secrets write-only and make their source visible. */
export function ProviderFields({
  descriptor,
  fields = [],
  patch,
  onChange,
  disabled,
  error,
  reset,
  onResetChange,
  copy,
  classes = {},
}: ProviderFieldsProps) {
  const id = useId();
  const labels = {
    stored: 'Saved on this instance',
    unset: 'Not configured',
    unchanged: 'Leave blank to keep the current value',
    clear: 'Remove saved value',
    unavailable: 'Stored credentials could not be read. Repair or remove them before saving.',
    reset: 'Remove all saved settings and credentials for this provider when saving.',
    endpointMismatch:
      'This saved key belongs to a different endpoint. Enter a key for the current endpoint to use it.',
    label: (id: string, fallback: string) => fallback || id,
    ...copy,
  };
  const update = (field: string, value: string | number | boolean | null | undefined) => {
    const next = { ...patch };
    if (value === undefined) delete next[field];
    else next[field] = value;
    onChange(next);
  };
  return (
    <div className={classes.root}>
      {onResetChange && (
        <label className={classes.label}>
          <input
            type="checkbox"
            checked={reset === true}
            disabled={disabled}
            onChange={(event) => onResetChange(event.target.checked)}
          />
          {labels.reset}
        </label>
      )}
      {error && (
        <p role="alert" className={classes.error}>
          {labels.unavailable}
        </p>
      )}
      {descriptor.fields.map((field) => {
        const status = reset ? undefined : fields.find((item) => item.id === field.id);
        const hasPatch = Object.prototype.hasOwnProperty.call(patch, field.id);
        const value = hasPatch ? patch[field.id] : status?.value;
        const inputId = `${id}-${field.id}`;
        return (
          <div key={field.id} className={classes.field}>
            <label htmlFor={inputId} className={classes.label}>
              {labels.label(field.id, field.label)}
            </label>
            {field.kind === 'boolean' ? (
              <input
                id={inputId}
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={(event) => update(field.id, event.target.checked)}
              />
            ) : (
              <input
                id={inputId}
                className={classes.input}
                disabled={disabled}
                type={field.secret ? 'password' : field.kind === 'number' ? 'number' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                value={
                  field.secret
                    ? typeof patch[field.id] === 'string'
                      ? String(patch[field.id])
                      : ''
                    : typeof value === 'string' || typeof value === 'number'
                      ? value
                      : ''
                }
                placeholder={field.secret && status?.configured ? labels.unchanged : field.placeholder}
                aria-describedby={`${inputId}-source`}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (field.secret) update(field.id, raw || undefined);
                  else if (field.kind === 'number') {
                    if (!raw) update(field.id, null);
                    else if (Number.isFinite(Number(raw))) update(field.id, Number(raw));
                  } else update(field.id, raw || null);
                }}
              />
            )}
            <p id={`${inputId}-source`} className={classes.hint}>
              {status?.error === 'endpoint_binding_mismatch'
                ? labels.endpointMismatch
                : status?.source === 'stored'
                  ? labels.stored
                  : labels.unset}
            </p>
            {status?.source === 'stored' && (
              <button
                type="button"
                className={classes.button}
                disabled={disabled || patch[field.id] === null}
                onClick={() => update(field.id, null)}
              >
                {labels.clear}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
