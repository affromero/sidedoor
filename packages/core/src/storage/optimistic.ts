import { randomUUID } from 'node:crypto';
import type { StateStore } from './index';

export interface StateSnapshot {
  revision: string;
  state: unknown;
}
export interface AtomicStateBackend {
  read(): Promise<StateSnapshot | null>;
  /** Must atomically compare the previous revision and persist both new revision and state. */
  compareAndSwap(previous: string | null, next: StateSnapshot): Promise<boolean>;
}
export interface OptimisticOptions<State> {
  backend: AtomicStateBackend;
  parse(value: unknown): State;
  initial(): State;
  maxAttempts?: number;
}

/** Supports database adapters without coupling the shared package to a particular ORM. */
export class OptimisticStateStore<State> implements StateStore<State> {
  private readonly attempts: number;
  constructor(private readonly options: OptimisticOptions<State>) {
    this.attempts = options.maxAttempts ?? 20;
    if (!Number.isSafeInteger(this.attempts) || this.attempts < 1)
      throw new Error('Transaction attempts must be positive');
  }
  async read(): Promise<State> {
    const snapshot = await this.options.backend.read();
    return this.options.parse(snapshot ? snapshot.state : this.options.initial());
  }
  async transact<Result>(operation: (state: State) => Result): Promise<Result> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const snapshot = await this.options.backend.read();
      const state = this.options.parse(structuredClone(snapshot ? snapshot.state : this.options.initial()));
      const result = operation(state);
      if (result instanceof Promise) throw new Error('State transaction callbacks must be synchronous');
      const detachedResult = structuredClone(result);
      const next = { revision: randomUUID(), state: this.options.parse(state) };
      if (await this.options.backend.compareAndSwap(snapshot?.revision ?? null, next)) return detachedResult;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 5 * (attempt + 1))));
    }
    throw new Error('State transaction conflicted with concurrent updates');
  }
}
