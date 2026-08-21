import { describe, expect, it, vi } from 'vitest';

import {
  createNeonDatabase,
  DatabaseConfigurationError,
  type SqlClient,
  type SqlClientFactory,
  type SqlTransactionResults,
} from './database.js';

describe('lazy Neon database', () => {
  it('does not create a driver client until a database operation is requested', async () => {
    const client: SqlClient = {
      query: async () => [{ ok: 1 }],
      transaction: async () => undefined,
    };
    const factory = vi.fn<SqlClientFactory>(() => client);
    const database = createNeonDatabase(
      'postgresql://role:password@ep-hq.neon.tech/headquarters',
      factory,
    );

    expect(database.configured).toBe(true);
    expect(database.initialized).toBe(false);
    expect(factory).not.toHaveBeenCalled();

    await expect(database.query<{ ok: number }>({ text: 'SELECT 1 AS ok' })).resolves.toEqual([
      { ok: 1 },
    ]);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      'postgresql://role:password@ep-hq.neon.tech/headquarters',
    );
    expect(database.initialized).toBe(true);
  });

  it('forwards ordered non-interactive transaction result sets through the lazy adapter', async () => {
    const expected: SqlTransactionResults = [[], [{ migration: '0001_control_plane_foundation' }]];
    const client: SqlClient = {
      query: async () => [],
      transaction: async () => expected,
    };
    const database = createNeonDatabase(
      'postgresql://role:password@ep-hq.neon.tech/headquarters',
      () => client,
    );

    await expect(
      database.transaction([{ text: 'SELECT 1' }, { text: 'SELECT 2 AS migration' }]),
    ).resolves.toEqual(expected);
  });
  it('rejects database operations without a configured Neon connection string', () => {
    const database = createNeonDatabase(undefined);

    expect(() => database.query({ text: 'SELECT 1' })).toThrow(DatabaseConfigurationError);
    expect(database.configured).toBe(false);
    expect(database.initialized).toBe(false);
  });
});
