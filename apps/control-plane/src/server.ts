import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { timestampNow } from '@bufbuild/protobuf/wkt';
import { cors, type ConnectRouter, type ServiceImpl } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  ControlPlaneService,
  IntegrationService,
  MaterialService,
  SettingsService,
  SyncService,
  TelemetryService,
  controlV1,
} from '@gremuchaya/protocol';
import type { syncV1 } from '@gremuchaya/protocol';

import { loadControlPlaneConfig, type ControlPlaneConfig } from './config.js';
import { attachRealtimeTransport } from './realtime/server.js';
import type { GroupEventPublication, RealtimeTransportOptions } from './realtime/server.js';
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

export interface RunningControlPlane {
  readonly server: ReturnType<typeof createServer>;
  publishGroupEvent(event: GroupEventPublication): Promise<syncV1.GroupEvent>;
  close(): Promise<void>;
}

interface ResolvedControlPlaneCollaborators {
  readonly syncService?: Partial<ServiceImpl<typeof SyncService>>;
  readonly settingsService?: Partial<ServiceImpl<typeof SettingsService>>;
  readonly materialService?: Partial<ServiceImpl<typeof MaterialService>>;
  readonly telemetryService?: Partial<ServiceImpl<typeof TelemetryService>>;
  readonly integrationService?: Partial<ServiceImpl<typeof IntegrationService>>;
  readonly realtime?: RealtimeTransportOptions;
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
   * What the health endpoint reports. It is captured at startup and never
   * probed: a health check that opened a network connection to Upstash would
   * make this endpoint fail for a reason that has nothing to do with whether
   * the control plane is serving.
   */
  readonly dependencies?: readonly DependencyReport[];
}

interface DependencyReport {
  readonly name: string;
  readonly configured: boolean;
  readonly detail: string;
}

export async function startControlPlane(
  config: ControlPlaneConfig,
  options: ControlPlaneStartOptions = {},
): Promise<RunningControlPlane> {
  const collaborators = await resolveControlPlaneCollaborators(config, options);
  const startedAt = timestampNow();
  const rpcHandler = connectNodeAdapter({
    connect: true,
    grpc: false,
    grpcWeb: true,
    routes: (router) => registerControlPlaneRoutes(router, startedAt, collaborators),
  });
  const server = createServer((request, response) => {
    if (!prepareRpcResponse(request, response, config)) return;
    void rpcHandler(request, response);
  });
  const realtime = attachRealtimeTransport(server, config, collaborators.realtime);

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(config.port, '127.0.0.1', resolveListening);
  });

  return {
    server,
    publishGroupEvent: (event: GroupEventPublication) => realtime.publish(event),
    close: async () => {
      await realtime.close();
      const closed = new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
      // `server.close` alone waits for every open connection, and `WatchGroup`
      // is a stream that by design never ends. Without this a control plane
      // with one watcher attached could not be shut down at all — which on a
      // shoot day means it cannot be restarted either.
      server.closeAllConnections();
      await closed;
    },
  };
}

function registerControlPlaneRoutes(
  router: ConnectRouter,
  startedAt: ReturnType<typeof timestampNow>,
  collaborators: ResolvedControlPlaneCollaborators,
): void {
  const pairedDeviceLifecycleEnabled = collaborators.syncService !== undefined;
  const authenticatedRealtimeEnabled = collaborators.realtime?.admission !== undefined;
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
          {
            name: 'integration',
            version: 'v1',
            enabled: collaborators.integrationService !== undefined,
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

async function resolveControlPlaneCollaborators(
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
    syncService: lifecycle.syncService,
    settingsService: lifecycle.settingsService,
    materialService: lifecycle.materialService,
    telemetryService: lifecycle.telemetryService,
    integrationService: lifecycle.integrationService,
    eventStore: lifecycle.eventStore,
    storageGrantsEnabled: lifecycle.storageConfigured,
    dependencies: [
      {
        name: 'database',
        configured: true,
        detail: 'Neon PostgreSQL; migrations applied before this endpoint began serving',
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

function prepareRpcResponse(
  request: IncomingMessage,
  response: ServerResponse,
  config: ControlPlaneConfig,
): boolean {
  setSecurityHeaders(response);
  const origin = request.headers.origin;
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    response.statusCode = 403;
    response.end();
    return false;
  }
  if (origin !== undefined) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader(
      'Vary',
      'Origin,Access-Control-Request-Method,Access-Control-Request-Headers',
    );
  }
  response.setHeader('Access-Control-Expose-Headers', cors.exposedHeaders.join(','));
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Methods', cors.allowedMethods.join(','));
    response.setHeader(
      'Access-Control-Allow-Headers',
      [...new Set([...cors.allowedHeaders, 'authorization', 'x-hq-bootstrap-secret'])].join(','),
    );
    response.setHeader('Access-Control-Max-Age', '7200');
    response.end();
    return false;
  }
  return true;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const config = loadControlPlaneConfig();
  const running = await startControlPlane(config);
  const address = running.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  process.stdout.write(`gremuchaya-control-plane listening on http://127.0.0.1:${port}\n`);
}

function isEntrypoint(moduleUrl: string, executablePath: string | undefined): boolean {
  if (executablePath === undefined) return false;
  const modulePath = new URL(moduleUrl).pathname.replace(/^\//u, '').replaceAll('/', '\\');
  return modulePath.toLocaleLowerCase('en-US') === executablePath.toLocaleLowerCase('en-US');
}
