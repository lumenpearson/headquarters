import { describe, expect, it } from 'vitest';

import type { ControlPlaneConfig } from './config.js';
import type { SqlClient, SqlStatement } from './db/database.js';

import { resolveControlPlaneCollaborators } from './routes.js';

/*
 * `Health` is unauthenticated and reports the database dependency as one
 * sentence, and that sentence is the only place an operator learns two facts
 * that decide whether this deployment can work where it stands: which driver
 * reaches the database, and whether the schema underneath was migrated by this
 * process or by a deployment step. A plane on the set that says it reaches the
 * database over HTTP is a plane whose group disappears with the internet, and
 * the operator has no other way to catch that before the shoot day does.
 */
describe('control-plane dependency report', () => {
  it('names the HTTP driver and its own migration when nothing was configured', async () => {
    const collaborators = await resolveControlPlaneCollaborators(configuredWith({}), {
      pairedDeviceLifecycle: { database: scriptedDatabase(), migrationRunner: async () => empty },
    });

    expect(detailOf(collaborators.dependencies, 'database')).toBe(
      'Neon PostgreSQL over HTTP; migrations applied before this endpoint began serving',
    );
  });

  it('names the TCP driver and the deployment step when the operator chose both', async () => {
    const collaborators = await resolveControlPlaneCollaborators(
      configuredWith({ databaseDriver: 'postgres', runMigrationsOnStart: false }),
      {
        pairedDeviceLifecycle: { database: scriptedDatabase(), migrationRunner: async () => empty },
      },
    );

    expect(detailOf(collaborators.dependencies, 'database')).toBe(
      'PostgreSQL over TCP; migrations are applied as a deployment step, not by this process',
    );
  });

  it('reports the driver and the migration source independently of each other', async () => {
    const collaborators = await resolveControlPlaneCollaborators(
      configuredWith({ databaseDriver: 'postgres' }),
      {
        pairedDeviceLifecycle: { database: scriptedDatabase(), migrationRunner: async () => empty },
      },
    );

    expect(detailOf(collaborators.dependencies, 'database')).toBe(
      'PostgreSQL over TCP; migrations applied before this endpoint began serving',
    );
  });
});

const empty = { applied: [], skipped: [] };

function detailOf(
  dependencies: readonly { readonly name: string; readonly detail: string }[] | undefined,
  name: string,
): string | undefined {
  return dependencies?.find((dependency) => dependency.name === name)?.detail;
}

function configuredWith(overrides: Partial<ControlPlaneConfig>): ControlPlaneConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    allowedOrigins: ['http://127.0.0.1:3000'],
    databaseUrl: 'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require',
    auth: {
      tokenHashVersion: 'v1',
      accessTokenLifetimeMs: 120_000,
      refreshTokenLifetimeMs: 7_200_000,
      pairingCodeLifetimeMs: 1_800_000,
      hashCredential: (kind, raw) => `hash-${kind}-${raw.length}`,
      verifyBootstrapSecret: (candidate) => candidate === 'test-bootstrap-secret',
    },
    ...overrides,
  };
}

/**
 * One scripted answer, the installation identity startup reads straight after
 * the migration gate. Nothing here reaches a database: the point of the suite
 * is what the report says, not what the schema holds.
 */
function scriptedDatabase(): SqlClient {
  const responses: Record<string, unknown>[][] = [
    [{ installation_id: '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30' }],
  ];
  return {
    async query<Row extends Record<string, unknown>>(_statement: SqlStatement) {
      return (responses.shift() ?? []) as readonly Row[];
    },
    async transaction() {
      /* no statement in this suite opens one */
    },
  };
}
