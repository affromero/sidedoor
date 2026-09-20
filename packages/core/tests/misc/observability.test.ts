import { describe, expect, it } from 'vitest';
import { MetricCollector, sumKnownCosts, type MetricEvent } from '../../src/observability/index';

const event = {
  version: 1,
  id: 'event-1',
  timestamp: 1,
  kind: 'execution',
  operation: 'generate',
  outcome: 'success',
  estimatedCost: null,
} as const;

describe('local telemetry', () => {
  it('does not present incomplete costs or mixed currencies as a total', () => {
    const usd = { ...event, estimatedCost: 0.5, currency: 'USD' };
    expect(sumKnownCosts([usd, event])).toBeNull();
    expect(sumKnownCosts([usd, { ...usd, currency: 'EUR' }])).toBeNull();
    expect(sumKnownCosts([usd, { ...usd, estimatedCost: 0 }])).toBe(0.5);
  });
  it('persists permitted measurements without prompts or credential fields', async () => {
    const saved: MetricEvent[] = [];
    const collector = new MetricCollector({
      sink: {
        async write(events) {
          saved.push(...events);
        },
      },
    });
    collector.record({ ...event, prompt: 'private paper', apiKey: 'secret', metadata: { token: 'secret' } });
    await collector.close();
    expect(saved).toEqual([event]);
    expect(sumKnownCosts(saved)).toBeNull();
  });

  it('bounds queued events and exposes dropped measurements', async () => {
    const collector = new MetricCollector({ capacity: 1, sink: { async write() {} } });
    expect(collector.record(event)).toBe(true);
    expect(collector.record(event)).toBe(false);
    expect(collector.status()).toMatchObject({ pending: 1, dropped: 1 });
    await collector.close();
    expect(collector.record(event)).toBe(false);
  });

  it('records usage for namespaced model identifiers', async () => {
    const saved: MetricEvent[] = [];
    const collector = new MetricCollector({
      sink: {
        async write(events) {
          saved.push(...events);
        },
      },
    });
    expect(collector.record({ ...event, model: 'organization/model:latest' })).toBe(true);
    await collector.close();
    expect(saved[0]?.model).toBe('organization/model:latest');
  });

  it('reports persistence failures without failing the caller', async () => {
    const collector = new MetricCollector({
      sink: {
        async write() {
          throw new Error('disk full');
        },
      },
    });
    collector.record(event);
    await collector.close();
    expect(collector.status()).toMatchObject({ pending: 0, failures: 1, dropped: 1 });
  });

  it('finishes shutdown when a sink does not respond', async () => {
    const collector = new MetricCollector({ timeoutMs: 10, sink: { write: () => new Promise(() => {}) } });
    collector.record(event);
    await collector.close();
    expect(collector.status()).toMatchObject({ failures: 1, closed: true });
  });
});
