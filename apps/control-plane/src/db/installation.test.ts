import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from './database.js';
import { readInstallationId } from './installation.js';

function database(
  answer: (statement: SqlStatement) => readonly Record<string, unknown>[],
  recorded: SqlStatement[] = [],
): SqlClient {
  return {
    query: async (statement) => {
      recorded.push(statement);
      return answer(statement);
    },
    transaction: async () => undefined,
  };
}

describe('control-plane installation identity', () => {
  it('reads the single row the installation migration minted', async () => {
    const recorded: SqlStatement[] = [];
    const client = database(
      () => [{ installation_id: '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30' }],
      recorded,
    );

    await expect(readInstallationId(client)).resolves.toBe('3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30');

    expect(recorded).toHaveLength(1);
    // The cast is what keeps the client's comparison a comparison of strings
    // whatever representation the driver chooses for `uuid`.
    expect(recorded[0]?.text).toContain('installation_id::text');
    expect(recorded[0]?.text).toContain('FROM control_plane_installation');
    expect(recorded[0]?.values ?? []).toEqual([]);
  });

  /*
   * The guard the whole feature rests on, from the other side: a control plane
   * that cannot read an identity must report "cannot compare" rather than
   * refuse to start. A schema that predates migration 0010 -- a rollback, or a
   * startup whose migration runner was seamed out -- raises `relation ... does
   * not exist`, and taking a serving deployment down for a fact only a client
   * needs would be a worse failure than the one being prevented.
   */
  it('answers an empty identity rather than throwing when the table is not there', async () => {
    const client = database(() => {
      throw new Error('relation "control_plane_installation" does not exist');
    });

    await expect(readInstallationId(client)).resolves.toBe('');
  });

  it('answers an empty identity when the row is missing or not a string', async () => {
    await expect(readInstallationId(database(() => []))).resolves.toBe('');
    await expect(readInstallationId(database(() => [{ installation_id: null }]))).resolves.toBe('');
    await expect(readInstallationId(database(() => [{}]))).resolves.toBe('');
  });
});
