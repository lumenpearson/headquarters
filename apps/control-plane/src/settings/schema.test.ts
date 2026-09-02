import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { settingsV1 } from '@gremuchaya/protocol';
import { settingsDefinitions, type SettingDefinition } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { createConfiguredPairedDeviceLifecycle } from '../sync/configured-lifecycle.js';
import type { PairedDeviceLifecycle } from '../sync/lifecycle.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { controlPlaneSettingsSchema } from './schema.js';
import { createSettingsService } from './service.js';

const groupId = '018b2a02-0000-7000-8000-000000000001';
const deviceId = '018b2a02-0000-7000-8000-000000000002';

/**
 * `GetSettingsSchema` was a declared method no deployment could answer: the
 * `schema` option was injected nowhere, so every call ended in `unimplemented`.
 * These tests are about the answer itself -- that the registry the client edits
 * is the registry the wire describes -- rather than about the shape of the
 * mapping code.
 */
describe('settings schema served over RPC', () => {
  it('describes every registry definition once, with no unspecified value type', () => {
    const schema = controlPlaneSettingsSchema();

    expect(schema.settings).toHaveLength(settingsDefinitions.length);
    expect(new Set(schema.settings.map((descriptor) => descriptor.path)).size).toBe(
      settingsDefinitions.length,
    );
    // An `UNSPECIFIED` value type is the wire's way of saying "the server does
    // not know", which for a setting the server is describing is never true.
    expect(
      schema.settings.filter(
        (descriptor) => descriptor.valueType === settingsV1.SettingValueType.UNSPECIFIED,
      ),
    ).toEqual([]);
    expect(schema.categories).toEqual([...new Set(schema.categories)]);
  });

  it('marks exactly the group-scoped definitions as publishable to a group', () => {
    const schema = controlPlaneSettingsSchema();
    const groupPaths = schema.settings
      .filter((descriptor) => descriptor.groupSyncAllowed)
      .map((descriptor) => descriptor.path)
      .sort();

    // The store refuses a device-scoped path in a group document; a descriptor
    // that advertised one would invite a client to offer a control the write
    // path then rejects.
    expect(groupPaths).toEqual(
      settingsDefinitions
        .filter((definition) => definition.scope === 'group')
        .map((definition) => definition.id)
        .sort(),
    );
    expect(groupPaths.length).toBeGreaterThan(0);
  });

  it('carries each editor kind across as the value type and constraint a client can act on', () => {
    const schema = controlPlaneSettingsSchema([
      fixture('example.flag', 'general', true, { kind: 'boolean' }),
      fixture('example.gap', 'sizes', 12, {
        kind: 'number',
        minimum: 0,
        maximum: 64,
        step: 2,
      }),
      fixture('example.mode', 'general', 'dark', { kind: 'enum', options: ['dark', 'light'] }),
      fixture('example.ids', 'tiles', ['a', 'b'], { kind: 'string-list', delimiter: ',' }),
      fixture('example.poster', 'materials', '', { kind: 'material', accept: ['image/'] }),
    ]);
    const byPath = new Map(schema.settings.map((descriptor) => [descriptor.path, descriptor]));

    expect(byPath.get('example.flag')?.valueType).toBe(settingsV1.SettingValueType.BOOLEAN);
    expect(byPath.get('example.flag')?.defaultValue?.kind).toEqual({
      case: 'booleanValue',
      value: true,
    });

    const gap = byPath.get('example.gap');
    expect(gap?.valueType).toBe(settingsV1.SettingValueType.NUMBER);
    expect(gap?.defaultValue?.kind).toEqual({ case: 'numberValue', value: 12 });
    expect(gap?.constraint).toMatchObject({ minimum: 0, maximum: 64, step: 2 });

    const mode = byPath.get('example.mode');
    expect(mode?.valueType).toBe(settingsV1.SettingValueType.STRING);
    expect(mode?.constraint?.allowedValues).toEqual(['dark', 'light']);

    const ids = byPath.get('example.ids');
    expect(ids?.valueType).toBe(settingsV1.SettingValueType.STRING_LIST);
    expect(ids?.defaultValue?.kind).toEqual({
      case: 'stringList',
      value: expect.objectContaining({ values: ['a', 'b'] }) as unknown,
    });

    // A material identifier is an opaque string on the wire; the accepted media
    // types are the picker's business and are not a value constraint, so none is
    // invented for it.
    expect(byPath.get('example.poster')?.valueType).toBe(settingsV1.SettingValueType.STRING);
    expect(byPath.get('example.poster')?.constraint).toBeUndefined();
  });

  it('derives a version that is stable for the same registry and different for a changed one', () => {
    const definitions = [fixture('example.flag', 'general', true, { kind: 'boolean' })];

    const first = controlPlaneSettingsSchema(definitions);
    const second = controlPlaneSettingsSchema(definitions);
    const changed = controlPlaneSettingsSchema([
      fixture('example.flag', 'general', false, { kind: 'boolean' }),
    ]);

    expect(first.version).toBe(second.version);
    expect(first.version).not.toBe(changed.version);
    expect(first.version).toMatch(/^hq-settings-[0-9a-f]{16}$/u);
  });

  it('does not change its version when two definitions are merely reordered', () => {
    const flag = fixture('example.flag', 'general', true, { kind: 'boolean' });
    const gap = fixture('example.gap', 'sizes', 12, {
      kind: 'number',
      minimum: 0,
      maximum: 64,
      step: 2,
    });

    // Declaration order is not content: a client's cached schema must survive an
    // edit that only moves a definition up the file.
    expect(controlPlaneSettingsSchema([flag, gap]).version).toBe(
      controlPlaneSettingsSchema([gap, flag]).version,
    );
  });

  it('answers the schema the assembled service was given, for an unversioned request', async () => {
    const schema = controlPlaneSettingsSchema();
    const service = createSettingsService({ runtime: stubLifecycle(), schema });
    const getSettingsSchema = requireHandler(service.getSettingsSchema);

    const response = await getSettingsSchema(
      create(settingsV1.GetSettingsSchemaRequestSchema, { version: '' }),
      handlerContext(),
    );

    expect(response.schema?.version).toBe(schema.version);
    expect(response.schema?.settings).toHaveLength(settingsDefinitions.length);
  });

  it('answers the same schema when the request names the version it serves', async () => {
    const schema = controlPlaneSettingsSchema();
    const service = createSettingsService({ runtime: stubLifecycle(), schema });
    const getSettingsSchema = requireHandler(service.getSettingsSchema);

    const response = await getSettingsSchema(
      create(settingsV1.GetSettingsSchemaRequestSchema, { version: schema.version }),
      handlerContext(),
    );

    expect(response.schema?.version).toBe(schema.version);
  });

  it('refuses a version it does not serve instead of answering a different one', async () => {
    const service = createSettingsService({
      runtime: stubLifecycle(),
      schema: controlPlaneSettingsSchema(),
    });
    const getSettingsSchema = requireHandler(service.getSettingsSchema);

    const failure = await failureOf(() =>
      getSettingsSchema(
        create(settingsV1.GetSettingsSchemaRequestSchema, {
          version: 'hq-settings-0000000000000000',
        }),
        handlerContext(),
      ),
    );

    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(Code.NotFound);
  });

  it('is injected by the configured composition root, so a real deployment can answer it', async () => {
    // The gap this closes was not in the handler but in the assembly: the handler
    // was written, tested and reachable, and no deployment ever gave it a schema.
    // Asserting on the assembled lifecycle is what proves the wiring, not a
    // second test of the mapping.
    const configured = await createConfiguredPairedDeviceLifecycle(
      {
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['http://127.0.0.1:3000'],
        databaseUrl: 'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require',
        auth: {
          tokenHashVersion: 'v1',
          accessTokenLifetimeMs: 120_000,
          refreshTokenLifetimeMs: 7_200_000,
          pairingCodeLifetimeMs: 1_800_000,
          hashCredential: (kind, raw) => `hash-${kind}-${String(raw.length)}`,
          verifyBootstrapSecret: (candidate) => candidate === 'test-bootstrap-secret',
        },
      },
      {
        database: new SilentSqlClient(),
        migrationRunner: async () => ({ applied: [], skipped: [] }),
      },
    );
    const getSettingsSchema = requireHandler(configured?.settingsService.getSettingsSchema);

    const response = await getSettingsSchema(
      create(settingsV1.GetSettingsSchemaRequestSchema, {}),
      handlerContext(),
    );

    expect(response.schema?.version).toBe(controlPlaneSettingsSchema().version);
    expect(response.schema?.settings).toHaveLength(settingsDefinitions.length);
  });

  it('still answers unimplemented when a service is assembled without a schema', async () => {
    const service = createSettingsService({ runtime: stubLifecycle() });
    const getSettingsSchema = requireHandler(service.getSettingsSchema);

    const failure = await failureOf(() =>
      getSettingsSchema(create(settingsV1.GetSettingsSchemaRequestSchema, {}), handlerContext()),
    );

    expect((failure as ConnectError).code).toBe(Code.Unimplemented);
  });
});

function fixture(
  id: string,
  category: SettingDefinition['category'],
  defaultValue: SettingDefinition['defaultValue'],
  editor: SettingDefinition['editor'],
  scope: SettingDefinition['scope'] = 'device',
): SettingDefinition {
  return {
    id,
    category,
    defaultValue,
    scope,
    description: `Fixture for ${id}.`,
    editor,
    validate: (_value): _value is SettingDefinition['defaultValue'] => true,
  };
}

function requireHandler<Handler>(handler: Handler | undefined): Handler {
  if (handler === undefined) throw new Error('Expected the service to implement this RPC');
  return handler;
}

/** A handler may answer synchronously, so its failure is captured rather than awaited. */
async function failureOf(call: () => unknown): Promise<unknown> {
  try {
    return await call();
  } catch (error: unknown) {
    return error;
  }
}

function handlerContext(): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: 'Bearer hq_access_settings' }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}

function stubLifecycle(): PairedDeviceLifecycle {
  const unreachable = (): never => {
    throw new Error('Serving the settings schema must not call the pairing lifecycle');
  };
  return {
    authenticateAccessToken: () => authenticatedDevice(),
    createGroup: unreachable,
    createPairingCode: unreachable,
    pairDevice: unreachable,
    refreshDeviceSession: unreachable,
    listDevices: unreachable,
    revokeDevice: unreachable,
  };
}

function authenticatedDevice(): AuthenticatedDevice {
  return {
    group: {
      id: groupId,
      name: 'Штаб',
      authorityMode: 'LEADER',
      leaderDeviceId: deviceId,
      revision: 1n,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    device: {
      id: deviceId,
      name: 'HQ primary',
      publicKey: 'ed25519:primary',
      role: 'ADMIN',
      status: 'ONLINE',
      platform: 'linux',
      applicationVersion: '0.5.0',
      createdAt: new Date(0),
      lastSeenAt: new Date(0),
    },
    role: 'ADMIN',
    sessionId: '018b2a02-0000-7000-8000-000000000003',
    accessTokenId: '018b2a02-0000-7000-8000-000000000004',
  };
}

/** Answers nothing to every statement: serving the schema must reach no table. */
class SilentSqlClient implements SqlClient {
  async query<Row extends Record<string, unknown>>(
    _statement: SqlStatement,
  ): Promise<readonly Row[]> {
    return [] as unknown as readonly Row[];
  }

  async transaction(): Promise<void> {
    return undefined;
  }
}
