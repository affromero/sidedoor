import { useId } from 'react';
import {
  compatibleProviders,
  type Capability,
  type ProviderDescriptor,
  type ProviderReadiness,
} from '../../../packages/core/src/ai/browser';
import { ProviderFields, type ProviderFieldsPatch, type ProviderFieldsProps } from './ProviderFields.js';

export interface ProviderSelectionDraft {
  provider: string;
  model: string;
  credentials: ProviderFieldsPatch;
}

export interface ProviderPickerProps {
  providers: readonly ProviderDescriptor[];
  requiredCapabilities?: readonly Capability[];
  value: ProviderSelectionDraft;
  onChange(value: ProviderSelectionDraft): void;
  allowCustomModel?: (provider: ProviderDescriptor) => boolean;
  fields?: ProviderFieldsProps['fields'];
  readiness?: ProviderReadiness;
  disabled?: boolean;
}

export function ProviderPicker({
  providers,
  requiredCapabilities = [],
  value,
  onChange,
  allowCustomModel,
  fields,
  readiness,
  disabled,
}: ProviderPickerProps) {
  const id = useId();
  const eligible = compatibleProviders(providers, requiredCapabilities);
  const selected = eligible.find((provider) => provider.id === value.provider);
  const models =
    selected?.models.filter((model) =>
      requiredCapabilities.every((capability) => model.capabilities.includes(capability)),
    ) ?? [];
  const custom = selected && allowCustomModel?.(selected);
  const keyless = selected?.transport === 'cli' || selected?.transport === 'ssh';
  const status =
    readiness?.code === 'not_installed'
      ? 'Install the CLI on the host that runs it.'
      : readiness?.code === 'not_authenticated'
        ? 'Sign in to the CLI on the host that runs it.'
        : 'Uses the CLI login on the host that runs it.';

  return (
    <div>
      <label htmlFor={`${id}-provider`}>Provider</label>
      <select
        id={`${id}-provider`}
        disabled={disabled}
        value={selected?.id ?? ''}
        onChange={(event) => onChange({ provider: event.target.value, model: '', credentials: {} })}
      >
        <option value="">Choose provider</option>
        {eligible.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
          </option>
        ))}
      </select>
      {selected && (
        <>
          <label htmlFor={`${id}-model`}>Model</label>
          {custom ? (
            <>
              <input
                id={`${id}-model`}
                list={`${id}-models`}
                disabled={disabled}
                value={value.model}
                onChange={(event) => onChange({ ...value, model: event.target.value })}
              />
              <datalist id={`${id}-models`}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <select
              id={`${id}-model`}
              value={models.some((model) => model.id === value.model) ? value.model : ''}
              disabled={disabled || models.length === 0}
              onChange={(event) => onChange({ ...value, model: event.target.value })}
            >
              <option value="">{models.length ? 'Choose model' : 'No compatible models'}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          {keyless ? (
            <p role="status">{status}</p>
          ) : (
            <ProviderFields
              descriptor={selected}
              fields={fields}
              patch={value.credentials}
              disabled={disabled}
              onChange={(credentials) => onChange({ ...value, credentials })}
            />
          )}
        </>
      )}
    </div>
  );
}
