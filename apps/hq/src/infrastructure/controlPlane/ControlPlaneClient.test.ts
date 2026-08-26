import { Code, ConnectError } from '@connectrpc/connect';
import { syncV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import {
  ControlPlaneClient,
  type ControlRpcClient,
  type SyncRpcClient,
} from './ControlPlaneClient';
import { DeviceSessionStore, memoryStorage } from './DeviceSessionStore';

function timestamp(epochMs: number) {
  return { seconds: BigInt(Math.floor(epochMs / 1000)), nanos: 0 };
}

interface Recorded {
  readonly refreshRequestIds: string[];
  readonly mutationContexts: { readonly requestId: string; readonly actorDeviceId?: string }[];
}

/**
 * A `SyncService` stated as the wire states it, not a spy on one. The claim
 * under test is which identifier crosses the wire on a retry, and only a fake
 * that keeps every request can answer that.
 */
function syncClient(recorded: Recorded, overrides: Partial<SyncRpcClient> = {}): SyncRpcClient {
  let refreshes = 0;
  const base: SyncRpcClient = {
    async pairDevice(request) {
      recorded.mutationContexts.push({ requestId: request.context.requestId });
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: syncV1.AuthorityMode.LEADER,
          leaderDeviceId: { value: 'device-a' },
        },
        device: {
          id: { value: 'device-a' },
          name: request.deviceName,
          role: syncV1.DeviceRole.EDITOR,
          status: syncV1.DeviceStatus.ONLINE,
        },
        session: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          accessTokenExpiresAt: timestamp(60_000),
          refreshTokenExpiresAt: timestamp(600_000),
          deviceId: { value: 'device-a' },
          groupId: { value: 'group-a' },
          role: syncV1.DeviceRole.EDITOR,
        },
      };
    },
    async refreshDeviceSession(request) {
      recorded.refreshRequestIds.push(request.context.requestId);
      refreshes += 1;
      return {
        session: {
          accessToken: `access-${refreshes + 1}`,
          refreshToken: `refresh-${refreshes + 1}`,
          accessTokenExpiresAt: timestamp(120_000),
          refreshTokenExpiresAt: timestamp(600_000),
          deviceId: { value: 'device-a' },
          groupId: { value: 'group-a' },
          role: syncV1.DeviceRole.EDITOR,
        },
      };
    },
    async listDevices() {
      return { devices: [], page: { nextCursor: '', hasMore: false } };
    },
    async revokeDevice(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {};
    },
    async joinGroup(request) {
      recorded.mutationContexts.push({
        requestId: request.context.requestId,
        ...(request.context.actorDeviceId === undefined
          ? {}
          : { actorDeviceId: request.context.actorDeviceId.value }),
      });
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: syncV1.AuthorityMode.MULTI_AUTHORITY,
          leaderDeviceId: { value: 'device-a' },
        },
      };
    },
    async leaveGroup() {
      return {};
    },
    async setAuthorityMode(request) {
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: request.mode,
          leaderDeviceId: { value: 'device-a' },
        },
      };
    },
    async setLeader(request) {
      return {
        group: {
          id: { value: 'group-a' },
          name: 'ШТАБ',
          authorityMode: syncV1.AuthorityMode.LEADER,
          leaderDeviceId: { value: request.deviceId.value },
        },
      };
    },
    async timeSync() {
      return { serverReceiveTime: timestamp(5_000), serverSendTime: timestamp(5_000) };
    },
    async getPresence() {
      return {
        devices: [
          {
            deviceId: { value: 'device-b' },
            status: syncV1.DeviceStatus.ONLINE,
            activeScreen: '/map',
            clockOffsetMs: 12n,
            latencyMs: 8,
            observedAt: timestamp(1_000),
          },
        ],
      };
    },
  };
  return { ...base, ...overrides };
}

const controlClient: ControlRpcClient = {
  async getCapabilities() {
    return {
      capabilities: [
        { name: 'sync', enabled: true },
        { name: 'sync.device-lifecycle', enabled: true },
        { name: 'sync.realtime-admission', enabled: false },
        { name: 'settings', enabled: true },
        { name: 'materials', enabled: false },
      ],
    };
  },
};

function client(options: { readonly sync?: SyncRpcClient; readonly now?: () => number } = {}) {
  const recorded: Recorded = { refreshRequestIds: [], mutationContexts: [] };
  const store = new DeviceSessionStore(memoryStorage());
  let minted = 0;
  const created = new ControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4100',
    sessionStore: store,
    clients: { control: controlClient, sync: options.sync ?? syncClient(recorded) },
    mintRequestId: () => {
      minted += 1;
      return `request-${minted}`;
    },
    now: options.now ?? (() => 0),
  });
  return { client: created, store, recorded };
}

describe('ControlPlaneClient', () => {
  it('reports only the capabilities the control plane says are enabled', async () => {
    const { client: created } = client();

    expect(await created.probeCapabilities()).toEqual({
      sync: true,
      deviceLifecycle: true,
      realtimeAdmission: false,
      settings: true,
      materials: false,
    });
  });

  it('stores the session envelope and never the deprecated scalar fields', async () => {
    const { client: created, store } = client();

    const paired = await created.pair('CODE-1', 'MON-01');

    expect(paired.session).toEqual({
      deviceId: 'device-a',
      groupId: 'group-a',
      role: 'EDITOR',
    });
    expect(paired.group.authority).toBe('leader');
    expect(store.read()?.accessToken).toBe('access-1');
    // The token belongs to the session store; the identity the store exposes
    // carries none of it.
    expect(Object.keys(paired.session)).toEqual(['deviceId', 'groupId', 'role']);
  });

  it('replays one request id while a refresh is unanswered and mints a new one after', async () => {
    const failing = { failures: 1 };
    const recorded: Recorded = { refreshRequestIds: [], mutationContexts: [] };
    const sync = syncClient(recorded, {
      async refreshDeviceSession(request) {
        recorded.refreshRequestIds.push(request.context.requestId);
        if (failing.failures > 0) {
          failing.failures -= 1;
          throw new ConnectError('network', Code.Unavailable);
        }
        return {
          session: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            accessTokenExpiresAt: timestamp(120_000),
            refreshTokenExpiresAt: timestamp(600_000),
            deviceId: { value: 'device-a' },
            groupId: { value: 'group-a' },
            role: syncV1.DeviceRole.EDITOR,
          },
        };
      },
    });
    const store = new DeviceSessionStore(memoryStorage());
    let minted = 0;
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => {
        minted += 1;
        return `request-${minted}`;
      },
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await expect(created.refresh()).rejects.toThrow();
    await created.refresh();
    await created.refresh();

    /*
     * The first two entries are one attempt and its retry, and they must be
     * identical: `RefreshDeviceSession` rotates destructively, and a retry
     * carrying a *different* id is what the server reads as a stolen token
     * being replayed -- it then revokes the whole family. The third is a new
     * attempt after a success, so it carries a new receipt.
     */
    const [first, second, third] = recorded.refreshRequestIds;
    expect(recorded.refreshRequestIds).toHaveLength(3);
    expect(second).toBe(first);
    expect(third).not.toBe(second);
  });

  it('forgets the session when a refresh is refused outright', async () => {
    const recorded: Recorded = { refreshRequestIds: [], mutationContexts: [] };
    const sync = syncClient(recorded, {
      async refreshDeviceSession() {
        throw new ConnectError('revoked', Code.Unauthenticated);
      },
    });
    const store = new DeviceSessionStore(memoryStorage());
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => 'request-1',
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await expect(created.refresh()).rejects.toMatchObject({ kind: 'unauthenticated' });

    // Nothing in the family is usable, so keeping it would only produce a
    // second refusal on the next launch.
    expect(store.read()).toBeNull();
    expect(created.session()).toBeNull();
  });

  it('names the authenticated device as the actor of every mutation', async () => {
    const { client: created, recorded } = client();
    await created.pair('CODE-1', 'MON-01');

    await created.join();

    const join = recorded.mutationContexts.at(-1);
    expect(join?.actorDeviceId).toBe('device-a');
    // A fresh receipt per mutation; pairing used the first identifier.
    expect(join?.requestId).not.toBe(recorded.mutationContexts[0]?.requestId);
  });

  it('refuses a session earned from a different control plane', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write({
      version: 1,
      controlPlaneUrl: 'http://192.168.10.5:4100',
      accessToken: 'access-elsewhere',
      refreshToken: 'refresh-elsewhere',
      accessTokenExpiresAt: 60_000,
      refreshTokenExpiresAt: 600_000,
      deviceId: 'device-a',
      groupId: 'group-a',
      role: 'EDITOR',
    });
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: {
        control: controlClient,
        sync: syncClient({ refreshRequestIds: [], mutationContexts: [] }),
      },
    });

    // Presenting it would earn a refusal that reads like a revoked device
    // rather than what it is: a changed address.
    expect(created.session()).toBeNull();
    expect(created.accessToken()).toBeUndefined();
  });

  it('turns a transport failure that never reached the host into an unavailable kind', async () => {
    const sync = syncClient(
      { refreshRequestIds: [], mutationContexts: [] },
      {
        async getPresence() {
          throw new TypeError('Failed to fetch');
        },
      },
    );
    const store = new DeviceSessionStore(memoryStorage());
    const created = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      sessionStore: store,
      clients: { control: controlClient, sync },
      mintRequestId: () => 'request-1',
      now: () => 0,
    });
    await created.pair('CODE-1', 'MON-01');

    await expect(created.getPresence()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reads presence and devices into the shapes the slice holds', async () => {
    const { client: created } = client();
    await created.pair('CODE-1', 'MON-01');

    expect(await created.getPresence()).toEqual([
      {
        deviceId: 'device-b',
        status: 'ONLINE',
        activeScreen: '/map',
        clockOffsetMs: 12,
        latencyMs: 8,
        observedAt: new Date(1_000).toISOString(),
      },
    ]);
  });
});
