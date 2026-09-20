import { describe, expect, it } from 'vitest';
import { checkSetup } from '../src/setup/index';

describe('setup readiness', () => {
  it('reports the actual blocking dependency and leaves optional features optional', async () => {
    const result = await checkSetup([
      {
        id: 'database',
        label: 'Database',
        required: true,
        async check() {
          return { code: 'ready', checkedAt: 1 };
        },
      },
      {
        id: 'speech',
        label: 'Speech',
        required: false,
        async check() {
          return { code: 'missing_credentials', checkedAt: 1, action: 'configure' };
        },
      },
      {
        id: 'speaking',
        label: 'Speaking',
        required: false,
        dependsOn: ['speech'],
        async check() {
          throw new Error('Blocked checks must not execute');
        },
      },
    ]);
    expect(result.ready).toBe(true);
    expect(result.results.find((item) => item.id === 'speaking')?.status).toMatchObject({
      code: 'blocked',
      blockedBy: ['speech'],
    });
  });

  it('rejects invalid dependency graphs instead of reporting readiness', async () => {
    await expect(
      checkSetup([
        {
          id: 'app',
          label: 'App',
          required: true,
          dependsOn: ['missing'],
          async check() {
            return { code: 'ready', checkedAt: 1 };
          },
        },
      ]),
    ).rejects.toThrow('dependencies');
  });
});
