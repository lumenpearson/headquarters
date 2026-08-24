import type { ControlPlaneConfig } from '../config.js';
import { createNeonDatabase, type SqlClient, type SqlClientFactory } from '../db/database.js';
import { runMigrations, type MigrationRunResult } from '../db/migrations.js';
import { DurableRealtimeEventStore } from '../realtime/eventStore.js';
import { RealtimeHub } from '../realtime/hub.js';
import type { RealtimeTransportOptions } from '../realtime/server.js';

import { DurablePairedDeviceRuntime } from './durable-runtime.js';
import { DurablePresenceStore } from './presence-store.js';
import { createPairedDeviceRealtimeAdmission } from './realtime-admission.js';
import { createPairedDeviceSyncService } from './service.js';

export type MigrationRunner = (database: SqlClient) => Promise<MigrationRunResult>;

export interface ConfiguredPairedDeviceLifecycleOptions {
  /**
   * Test seam for a deterministic in-memory SqlClient. Production callers use
   * the configured Neon client instead.
   */
  readonly database?: SqlClient;
  /**
   * Optional Neon driver seam. It is used only when `database` is not
   * supplied, so tests never need a live connection string or network call.
   */
  readonly databaseFactory?: SqlClientFactory;
  readonly migrationRunner?: MigrationRunner;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface ConfiguredPairedDeviceLifecycle {
  readonly runtime: DurablePairedDeviceRuntime;
  readonly eventStore: DurableRealtimeEventStore;
  readonly presence: DurablePresenceStore;
  readonly hub: RealtimeHub;
  readonly syncService: ReturnType<typeof createPairedDeviceSyncService>;
  readonly realtime: RealtimeTransportOptions;
  readonly migrations: MigrationRunResult;
}

/**
 * Builds the production paired-device composition root only when the explicit
 * all-or-nothing auth configuration is present. The migration gate completes
 * before any RPC or realtime collaborator is returned, preventing startup
 * from advertising durable auth against an old schema.
 */
export async function createConfiguredPairedDeviceLifecycle(
  config: ControlPlaneConfig,
  options: ConfiguredPairedDeviceLifecycleOptions = {},
): Promise<ConfiguredPairedDeviceLifecycle | undefined> {
  const auth = config.auth;
  if (auth === undefined) return undefined;
  if (config.databaseUrl === undefined) {
    throw new Error(
      'HQ_CONTROL_PLANE_DATABASE_URL is required for configured paired-device authentication',
    );
  }
  if (options.database !== undefined && options.databaseFactory !== undefined) {
    throw new Error('Provide either database or databaseFactory, not both');
  }

  const database =
    options.database ?? createNeonDatabase(config.databaseUrl, options.databaseFactory);
  const migrations = await (options.migrationRunner ?? runMigrations)(database);
  const runtime = new DurablePairedDeviceRuntime({
    database,
    hashCredential: (kind, credential) => auth.hashCredential(kind, credential),
    tokenHashVersion: auth.tokenHashVersion,
    accessTokenLifetimeMs: auth.accessTokenLifetimeMs,
    refreshTokenLifetimeMs: auth.refreshTokenLifetimeMs,
    pairingCodeLifetimeMs: auth.pairingCodeLifetimeMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  });

  // The event store shares the runtime's own receipt guard rather than building
  // a second one: a retry must be recognised as a retry no matter which module
  // received it, and two guards with two hashers would not agree.
  const eventStore = new DurableRealtimeEventStore({
    database,
    receipts: runtime.receiptGuard,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const presence = new DurablePresenceStore({
    database,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const hub = new RealtimeHub({ store: eventStore });

  return {
    runtime,
    migrations,
    eventStore,
    presence,
    hub,
    syncService: createPairedDeviceSyncService({
      runtime,
      verifyBootstrapSecret: auth.verifyBootstrapSecret,
      administration: runtime,
      presence,
      eventStore,
      hub,
    }),
    realtime: {
      admission: createPairedDeviceRealtimeAdmission(runtime),
      hub,
    },
  };
}
