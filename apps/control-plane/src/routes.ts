import { timestampNow } from '@bufbuild/protobuf/wkt';
import type { ConnectRouter, ServiceImpl } from '@connectrpc/connect';
import {
  ControlPlaneService,
  IntegrationService,
  MaterialService,
  SettingsService,
  SyncService,
  TelemetryService,
  controlV1,
} from '@gremuchaya/protocol';

import type { ControlPlaneConfig } from './config.js';
import type { RealtimeTransportOptions } from './realtime/server.js';
import {
  createConfiguredPairedDeviceLifecycle,
  type ConfiguredPairedDeviceLifecycleOptions,
} from './sync/configured-lifecycle.js';

const serviceVersion = '0.1.0';
const protocolVersion = 'gremuchaya.v1';

export interface ControlPlaneStartOptions {
  /**
   * Explicit SyncService injection is reserved for health-only/test startup.
   * Auth-configured startup always constructs the durable lifecycle instead so
   * it cannot accidentally advertise an in-memory or mismatched auth runtime.
   */
  readonly syncService?: Partial<ServiceImpl<typeof SyncService>>;
  readonly realtime?: RealtimeTransportOptions;
  /**
   * Composition-root seam for deterministic startup tests. It has no effect
   * unless the complete auth configuration is enabled.
   */
  readonly pairedDeviceLifecycle?: ConfiguredPairedDeviceLifecycleOptions;
}

export interface ResolvedControlPlaneCollaborators {
  readonly syncService?: Partial<ServiceImpl<typeof SyncService>>;
  readonly settingsService?: Partial<ServiceImpl<typeof SettingsService>>;
  readonly materialService?: Partial<ServiceImpl<typeof MaterialService>>;
  readonly telemetryService?: Partial<ServiceImpl<typeof TelemetryService>>;
  readonly integrationService?: Partial<ServiceImpl<typeof IntegrationService>>;
  readonly realtime?: RealtimeTransportOptions;
  /**
   * Whether this transport actually accepts the realtime WebSocket upgrade.
   *
   * An admission collaborator says who *may* open a socket; it is built
   * whenever authentication is configured, on both adapters. Only the Node
   * adapter owns an HTTP server for `attachRealtimeTransport` to put an
   * `upgrade` handler on, so it alone sets this. A serverless Fetch
   * deployment leaves it unset, and `getCapabilities` then reports
   * `sync.realtime-admission` off -- which is what makes the client choose the
   * polling feed over a socket nothing would answer.
   */
  readonly realtimeSocketServed?: boolean;
  /**
   * Present only when a durable event log was built. `getCapabilities` reports
   * the `sync` surface from this rather than from a constant, so a reduced
   * startup cannot advertise methods it answers `unimplemented`.
   */
  readonly eventStore?: unknown;
  /**
   * Whether the material service can mint upload, download and preview grants.
   * Reported by `getCapabilities` as `materials.storage-grants` so a client can
   * tell a library it may upload to from one it can only list.
   */
  readonly storageGrantsEnabled?: boolean;
  /**
   * Whether the integration service can reach GitHub. Reported by
   * `getCapabilities` as `integration.github-egress` so a client can tell a
   * deployment that can open an issue from one that can only build the draft
   * and the prefilled link.
   */
  readonly githubEgressEnabled?: boolean;
  /**
   * What the health endpoint reports. It is captured at startup and never
   * probed: a health check that opened a network connection to Upstash would
   * make this endpoint fail for a reason that has nothing to do with whether
   * the control plane is serving.
   */
  readonly dependencies?: readonly DependencyReport[];
  /**
   * The identity of the database this process reached, reported verbatim by
   * `GetCapabilities`. Absent in health-only startup and empty when the schema
   * predates migration 0010; both answer `''` on the wire, because a client
   * has to be able to tell "cannot compare" from "a different database".
   */
  readonly installationId?: string;
}

export interface DependencyReport {
  readonly name: string;
  readonly configured: boolean;
  readonly detail: string;
}

export function registerControlPlaneRoutes(
  router: ConnectRouter,
  startedAt: ReturnType<typeof timestampNow>,
  collaborators: ResolvedControlPlaneCollaborators,
): void {
  const pairedDeviceLifecycleEnabled = collaborators.syncService !== undefined;
  // Both halves are required: someone to authorize the connection, and a
  // transport that can accept it. Reporting the first alone told a Vercel
  // deployment's own client to open a socket the deployment cannot serve.
  const authenticatedRealtimeEnabled =
    collaborators.realtime?.admission !== undefined && collaborators.realtimeSocketServed === true;
  router.service(ControlPlaneService, {
    health() {
      return {
        service: 'gremuchaya-control-plane',
        version: serviceVersion,
        protocolVersion,
        status: controlV1.ServingStatus.SERVING,
        startedAt,
        checkedAt: timestampNow(),
        dependencies: (collaborators.dependencies ?? []).map((dependency) => ({
          name: dependency.name,
          status: dependency.configured
            ? controlV1.ServingStatus.SERVING
            : controlV1.ServingStatus.NOT_SERVING,
          latencyMs: 0,
          detail: dependency.detail,
        })),
      };
    },
    getCapabilities() {
      return {
        // Read once at startup beside the dependency report, never per request:
        // this endpoint is unauthenticated, and a database query behind it would
        // hand anyone who can reach the port a way to make the control plane do
        // work. `''` is the honest answer of a process that reached no database.
        installationId: collaborators.installationId ?? '',
        capabilities: [
          { name: 'control.health', version: 'v1', enabled: true },
          { name: 'transport.connect', version: 'v1', enabled: true },
          { name: 'transport.grpc-web', version: 'v1', enabled: true },
          {
            name: 'materials',
            version: 'v1',
            enabled: collaborators.materialService !== undefined,
          },
          {
            name: 'materials.storage-grants',
            version: 'v1',
            enabled: collaborators.storageGrantsEnabled === true,
          },
          { name: 'settings', version: 'v1', enabled: collaborators.settingsService !== undefined },
          {
            name: 'sync.device-lifecycle',
            version: 'v1',
            enabled: pairedDeviceLifecycleEnabled,
          },
          { name: 'sync.realtime-admission', version: 'v1', enabled: authenticatedRealtimeEnabled },
          // The group-event, presence and session-command surface is reachable
          // only when the composition root supplied a durable event log; a
          // startup that injects the deterministic pairing runtime alone still
          // answers those methods `unimplemented`.
          { name: 'sync', version: 'v1', enabled: collaborators.eventStore !== undefined },
          {
            name: 'telemetry',
            version: 'v1',
            enabled: collaborators.telemetryService !== undefined,
          },
          // The measurement half is read off the built service rather than off
          // a constant, for the same reason `sync` is read off the event store:
          // a deployment whose schema predates the registry and sample store
          // builds the simulation half alone and answers `ListDataSources`,
          // `GetTelemetrySnapshot` and `StreamTelemetry` `unimplemented`. A
          // client that was told otherwise would open a stream nothing serves.
          {
            name: 'telemetry.measurement',
            version: 'v1',
            enabled: collaborators.telemetryService?.listDataSources !== undefined,
          },
          {
            name: 'integration',
            version: 'v1',
            enabled: collaborators.integrationService !== undefined,
          },
          // The outbound half, read off the built gateway for the same reason
          // `materials.storage-grants` is read off the issuer: `BuildIssueDraft`
          // and `OpenPrefilledIssue` work on a plane that will never reach
          // GitHub, and `CreateIssue`, `CreateTranslationPullRequest` and
          // `GetPullRequestStatus` refuse there. A client told otherwise would
          // offer to file a report the deployment cannot send.
          {
            name: 'integration.github-egress',
            version: 'v1',
            enabled: collaborators.githubEgressEnabled === true,
          },
        ],
      };
    },
  });
  if (collaborators.syncService !== undefined)
    router.service(SyncService, collaborators.syncService);
  if (collaborators.settingsService !== undefined)
    router.service(SettingsService, collaborators.settingsService);
  if (collaborators.materialService !== undefined)
    router.service(MaterialService, collaborators.materialService);
  if (collaborators.telemetryService !== undefined)
    router.service(TelemetryService, collaborators.telemetryService);
  if (collaborators.integrationService !== undefined)
    router.service(IntegrationService, collaborators.integrationService);
}

export async function resolveControlPlaneCollaborators(
  config: ControlPlaneConfig,
  options: ControlPlaneStartOptions,
): Promise<ResolvedControlPlaneCollaborators> {
  if (config.auth === undefined) {
    return {
      ...(options.syncService === undefined ? {} : { syncService: options.syncService }),
      ...(options.realtime === undefined ? {} : { realtime: options.realtime }),
    };
  }
  if (options.syncService !== undefined) {
    throw new Error(
      'Auth-configured control-plane startup cannot override the durable SyncService lifecycle',
    );
  }
  if (options.realtime?.admission !== undefined) {
    throw new Error(
      'Auth-configured control-plane startup cannot override durable realtime admission',
    );
  }
  if (options.realtime?.allowUnauthenticatedDevelopment === true) {
    throw new Error(
      'Auth-configured control-plane startup cannot enable unauthenticated realtime transport',
    );
  }

  const lifecycle = await createConfiguredPairedDeviceLifecycle(
    config,
    options.pairedDeviceLifecycle,
  );
  if (lifecycle === undefined) {
    throw new Error('Auth-configured control-plane startup did not produce a durable lifecycle');
  }

  return {
    installationId: lifecycle.installationId,
    syncService: lifecycle.syncService,
    settingsService: lifecycle.settingsService,
    materialService: lifecycle.materialService,
    telemetryService: lifecycle.telemetryService,
    integrationService: lifecycle.integrationService,
    eventStore: lifecycle.eventStore,
    storageGrantsEnabled: lifecycle.storageConfigured,
    githubEgressEnabled: lifecycle.githubConfigured,
    dependencies: [
      {
        name: 'database',
        configured: true,
        // Two facts an operator has no other way to read off an
        // unauthenticated Health. Which driver reaches the database: the HTTP
        // one needs a route to the public internet on every statement, the TCP
        // one a route to a single machine, and a plane on the set that reports
        // the wrong one is a plane whose group will stop existing when the
        // internet does. And whether the schema underneath is one this process
        // migrated itself or one a deployment step left behind.
        detail: `${
          config.databaseDriver === 'postgres' ? 'PostgreSQL over TCP' : 'Neon PostgreSQL over HTTP'
        }; ${
          config.runMigrationsOnStart === false
            ? 'migrations are applied as a deployment step, not by this process'
            : 'migrations applied before this endpoint began serving'
        }`,
      },
      {
        name: 'redis',
        configured: lifecycle.coordination.configured,
        detail: lifecycle.coordination.configured
          ? 'Upstash coordination for presence liveness and mutation rate limiting'
          : 'not configured; presence reports the last recorded state and mutations are unlimited',
      },
      {
        // Health is unauthenticated, so the detail names neither the endpoint
        // nor the bucket: what an operator needs to know from here is whether
        // grants can be minted and for how long they stay valid.
        name: 'storage',
        configured: lifecycle.storageConfigured,
        detail:
          lifecycle.storageConfigured && config.storage !== undefined
            ? `S3-compatible object storage; presigned upload, download and preview grants expire after ${Math.trunc(config.storage.grantTtlMs / 1000).toString()} s`
            : 'not configured; BeginUpload, CreateMaterialVersion, GetDownloadGrant and GetPreviewGrant answer FAILED_PRECONDITION',
      },
      {
        // Health is unauthenticated, so the detail names neither the token nor
        // the repository it may be spent against: what an operator needs from
        // here is whether this plane can send to GitHub at all.
        name: 'github',
        configured: lifecycle.githubConfigured,
        detail: lifecycle.githubConfigured
          ? 'GitHub REST egress for issues, translation pull requests and pull-request status'
          : 'not configured; CreateIssue, CreateTranslationPullRequest and GetPullRequestStatus answer FAILED_PRECONDITION',
      },
    ],
    realtime: {
      ...lifecycle.realtime,
      ...(options.realtime?.hub === undefined ? {} : { hub: options.realtime.hub }),
      ...(options.realtime?.revalidationIntervalMs === undefined
        ? {}
        : { revalidationIntervalMs: options.realtime.revalidationIntervalMs }),
    },
  };
}
