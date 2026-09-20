import type { Capability, ProviderReadiness } from '../ai/browser';
import { abortable } from '../runtime/abort';

export interface SetupRequirement {
  id: string;
  label: string;
  required: boolean;
  dependsOn?: readonly string[];
  capabilities?: readonly Capability[];
  check(signal: AbortSignal): Promise<ProviderReadiness>;
}
export interface SetupResult {
  id: string;
  label: string;
  required: boolean;
  status: ProviderReadiness | { code: 'blocked'; checkedAt: number; blockedBy: string[] };
}

/** Apps supply their real dependency graph; there is no universal AI-ready shortcut. */
export async function checkSetup(
  requirements: readonly SetupRequirement[],
  signal = AbortSignal.timeout(15_000),
): Promise<{ ready: boolean; results: SetupResult[] }> {
  const definitions = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  if (definitions.size !== requirements.length) throw new Error('Duplicate setup requirement');
  const results = new Map<string, SetupResult>();
  const pending = new Set(definitions.keys());
  while (pending.size) {
    signal.throwIfAborted();
    const available = [...pending].filter((id) =>
      (definitions.get(id)?.dependsOn ?? []).every((dependency) => results.has(dependency)),
    );
    if (!available.length) throw new Error('Setup dependencies contain a cycle or unknown requirement');
    await Promise.all(
      available.map(async (id) => {
        const requirement = definitions.get(id)!;
        const blockedBy = (requirement.dependsOn ?? []).filter(
          (dependency) => results.get(dependency)?.status.code !== 'ready',
        );
        let status: SetupResult['status'];
        if (blockedBy.length) status = { code: 'blocked', checkedAt: Date.now(), blockedBy };
        else {
          try {
            status = await abortable(requirement.check(signal), signal);
          } catch (error) {
            if (signal.aborted) throw error;
            status = { code: 'unreachable', checkedAt: Date.now(), action: 'retry' };
          }
        }
        results.set(id, { id, label: requirement.label, required: requirement.required, status });
        pending.delete(id);
      }),
    );
  }
  const ordered = requirements.map((requirement) => results.get(requirement.id)!);
  return {
    ready: ordered.every((result) => !result.required || result.status.code === 'ready'),
    results: ordered,
  };
}
