import type { ControlPlaneConfig } from '../config.js';
import {
  createDatabase,
  sqlClientFactoryFor,
  type SqlClient,
  type SqlClientFactory,
} from '../db/database.js';
import { readInstallationId } from '../db/installation.js';
import { runMigrations, type MigrationRunResult } from '../db/migrations.js';
import { DurableIntegrationStore } from '../integration/store.js';
import { createIntegrationService } from '../integration/service.js';
import {
  createGitHubRestGateway,
  type GitHubGatewayFactory,
} from '../integration/github-gateway.js';
import { DurableMaterialStore } from '../material/store.js';
import { createMaterialService } from '../material/service.js';
import { DurableRealtimeEventStore } from '../realtime/eventStore.js';
import { RealtimeHub } from '../realtime/hub.js';
import type { RealtimeTransportOptions } from '../realtime/server.js';
import {
  createUpstashCoordination,
  type CoordinationClientFactory,
  type UpstashCoordination,
} from '../redis/coordination.js';
import { createRedisRealtimeFanout } from '../redis/fanout.js';

import { CoordinatedPresenceStore } from './coordinated-presence-store.js';
import { DurablePairedDeviceRuntime } from './durable-runtime.js';
import { DurablePresenceStore } from './presence-store.js';
import type { PresenceStore } from './presence-store.js';
import { createPairedDeviceRealtimeAdmission } from './realtime-admission.js';
import { createPairedDeviceSyncService } from './service.js';
import { DurableSettingsStore } from '../settings/store.js';
import { controlPlaneSettingsSchema } from '../settings/schema.js';
import { createSettingsService } from '../settings/service.js';
import { createS3GrantIssuer, type StorageGrantIssuerFactory } from '../storage/s3-grant-issuer.js';
import { DurableTelemetryMeasurementStore } from '../telemetry/measurement-store.js';
import { DurableSimulationProfileStore } from '../telemetry/store.js';
import { createTelemetryService } from '../telemetry/service.js';

export type MigrationRunner = (database: SqlClient) => Promise<MigrationRunResult>;

export interface ConfiguredPairedDeviceLifecycleOptions {
  /**
   * Test seam for a deterministic in-memory SqlClient. Production callers get
   * the client the configured driver builds instead.
   */
  readonly database?: SqlClient;
  /**
   * Optional driver seam. It is used only when `database` is not supplied, and
   * it overrides `config.databaseDriver`, so tests never need a live connection
   * string or network call.
   */
  readonly databaseFactory?: SqlClientFactory;
  readonly migrationRunner?: MigrationRunner;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  /**
   * Optional Upstash driver seam, so a test can exercise the coordinated
   * presence path without a cloud connection.
   */
  readonly coordinationFactory?: CoordinationClientFactory;
  /**
   * Optional object-storage seam, so a test can drive the multipart lifecycle
   * against a scripted bucket instead of a real one. It is consulted only when
   * `config.storage` is present; without a bucket no issuer exists and the
   * grant-minting RPCs keep refusing.
   */
  readonly storageFactory?: StorageGrantIssuerFactory;
  /**
   * Optional GitHub-egress seam, so a test can drive the outbound calls against
   * a scripted GitHub instead of the real API. It is consulted only when
   * `config.github` is present; without a token no gateway exists and the three
   * outbound RPCs keep refusing.
   */
  readonly githubFactory?: GitHubGatewayFactory;
}

export interface ConfiguredPairedDeviceLifecycle {
  readonly runtime: DurablePairedDeviceRuntime;
  /**
   * The identity of the database the migrations above just ran against, which
   * `GetCapabilities` reports so a paired client can tell this database from a
   * replacement answering at the same address. `''` when the schema predates
   * migration 0010.
   */
  readonly installationId: string;
  readonly eventStore: DurableRealtimeEventStore;
  readonly presence: PresenceStore;
  readonly coordination: UpstashCoordination;
  /** Whether a `StorageGrantIssuer` was built, which is what `Health` and `GetCapabilities` report. */
  readonly storageConfigured: boolean;
  /** Whether a GitHub gateway was built, which is what `Health` and `GetCapabilities` report. */
  readonly githubConfigured: boolean;
  readonly hub: RealtimeHub;
  readonly syncService: ReturnType<typeof createPairedDeviceSyncService>;
  readonly settingsService: ReturnType<typeof createSettingsService>;
  readonly materialService: ReturnType<typeof createMaterialService>;
  readonly telemetryService: ReturnType<typeof createTelemetryService>;
  readonly integrationService: ReturnType<typeof createIntegrationService>;
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
    options.database ??
    createDatabase(
      config.databaseUrl,
      options.databaseFactory ?? sqlClientFactoryFor(config.databaseDriver),
    );
  // A deployment that applies the sequence as a build step says so, and this
  // startup then touches no ledger at all: `applied` and `skipped` are both
  // empty because no migration was considered, not because none was pending.
  // What an operator reads instead is the `database` dependency detail, which
  // names which of the two happened.
  const migrations =
    config.runMigrationsOnStart === false
      ? { applied: [], skipped: [] }
      : await (options.migrationRunner ?? runMigrations)(database);
  // Read after the migration gate and never again: the identity is minted by
  // 0010 and is immutable for the life of the database, so a second read could
  // only ever return the same value at the cost of a query on an
  // unauthenticated endpoint.
  const installationId = await readInstallationId(database);
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
  const durablePresence = new DurablePresenceStore({
    database,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // Lazy by construction: nothing reaches Upstash until the first coordinated
  // call, so an unreachable Redis cannot hold up startup or a health check.
  const coordination = createUpstashCoordination(config.redis, options.coordinationFactory);
  const presence: PresenceStore = coordination.configured
    ? new CoordinatedPresenceStore(durablePresence, coordination)
    : durablePresence;
  // The cross-process carrier exists exactly when Redis does. Without one the
  // hub serves only what this process published, which is why a deployment
  // without Redis still pins itself to a single replica: a second one would
  // split the audience of every live publication silently.
  const fanout = createRedisRealtimeFanout({ coordination });
  const hub = new RealtimeHub({
    store: eventStore,
    ...(fanout === undefined ? {} : { fanout }),
  });
  // Every store shares the runtime's own receipt guard rather than building its
  // own: one request identifier has to mean the same thing whichever service
  // received it, and two guards with two hashers would not agree.
  const receipts = runtime.receiptGuard;
  const settingsStore = new DurableSettingsStore({ database, receipts });
  const materialStore = new DurableMaterialStore({ database, receipts });
  const simulationProfiles = new DurableSimulationProfileStore({ database, receipts });
  // The measurement half needs no receipt guard: none of its three RPCs is a
  // mutation a client can retry. The one write it does is a capture the server
  // decides to take, addressed by a sequence the server allocates, so there is
  // no client-supplied identity for a receipt to be about.
  const telemetryMeasurements = new DurableTelemetryMeasurementStore({ database });
  const integrationStore = new DurableIntegrationStore({ database, receipts });
  // The issuer is a pure signer over the configured bucket: building it opens no
  // connection, and the first network call is the CreateMultipartUpload of the
  // first real upload. The credentials stay inside `config.storage`'s closures.
  const storage =
    config.storage === undefined
      ? undefined
      : (options.storageFactory ?? createS3GrantIssuer)(config.storage);
  // Built for the same reason and on the same terms as the storage issuer:
  // constructing it opens no connection, the first request is the first
  // outbound call a client asks for, and the deployment token stays inside
  // `config.github`'s closure rather than being copied onto the gateway.
  const githubConfig = config.github;
  const github =
    githubConfig === undefined
      ? undefined
      : (options.githubFactory ?? createGitHubRestGateway)(githubConfig);

  return {
    runtime,
    installationId,
    migrations,
    eventStore,
    presence,
    coordination,
    storageConfigured: storage !== undefined,
    githubConfigured: github !== undefined,
    hub,
    syncService: createPairedDeviceSyncService({
      runtime,
      verifyBootstrapSecret: auth.verifyBootstrapSecret,
      administration: runtime,
      presence,
      eventStore,
      hub,
      coordination,
    }),
    // The material service receives the storage issuer only when a bucket is
    // configured; otherwise the four grant-minting RPCs answer
    // `FAILED_PRECONDITION` naming what is missing while everything else works.
    // The GitHub gateway is wired on exactly those terms: present when
    // `HQ_CONTROL_PLANE_GITHUB_*` is, absent otherwise, and the three outbound
    // RPCs refuse with the variables named rather than pretending to send.
    // The schema is injected here rather than left absent: `GetSettingsSchema`
    // needs no database, only the shared registry, so a deployment that reaches
    // this point can always answer it. Leaving it out made a declared method
    // answer `unimplemented` in every deployment there has ever been.
    settingsService: createSettingsService({
      runtime,
      store: settingsStore,
      schema: controlPlaneSettingsSchema(),
    }),
    materialService: createMaterialService({
      runtime,
      store: materialStore,
      ...(storage === undefined ? {} : { storage }),
    }),
    // The measurement store is always supplied here, because reaching this
    // point means the migration gate ran and migration 0011 declared the
    // registry and the sample store. It stays an option of the service rather
    // than a requirement so a deployment that applies migrations as a separate
    // step, and a test that exercises the simulation half alone, can build the
    // service without one and have the three RPCs answer `unimplemented`
    // honestly instead of failing against tables that are not there.
    telemetryService: createTelemetryService({
      runtime,
      profiles: simulationProfiles,
      measurements: telemetryMeasurements,
    }),
    // The deployment credential is passed as the closure that opens it, not as
    // a value: `config.github` holds the token and this composition root never
    // reads it, so nothing between here and the outbound call has a copy.
    integrationService: createIntegrationService({
      runtime,
      store: integrationStore,
      ...(github === undefined || githubConfig === undefined
        ? {}
        : {
            github,
            githubCredentials: () => githubConfig.openToken(),
            issueRepository: githubConfig.repository,
            issueLabels: githubConfig.issueLabels,
          }),
    }),
    realtime: {
      admission: createPairedDeviceRealtimeAdmission(runtime),
      hub,
    },
  };
}
