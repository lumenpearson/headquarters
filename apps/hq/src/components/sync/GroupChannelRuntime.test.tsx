// @vitest-environment jsdom
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { realtimeV1, syncV1 } from '@gremuchaya/protocol';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneLinkState } from '@/application/sync/connection';
import { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import {
  ControlPlaneClient,
  type ControlRpcClient,
  type SyncRpcClient,
} from '@/infrastructure/controlPlane/ControlPlaneClient';
import {
  DeviceSessionStore,
  memoryStorage,
} from '@/infrastructure/controlPlane/DeviceSessionStore';
import { operationsStore } from '@/state/operationsStore';

import type { ControlPlaneLink } from './ControlPlaneRuntime';
import { GroupChannelRuntime } from './GroupChannelRuntime';
import { GroupPairingDialog, openGroupPairing } from './GroupPairingDialog';
import { currentGroupRuntime } from './groupRuntimeHolder';

/* Placeholder addresses: the plane on the set's LAN, and the cloud plane. */
const nearPlane = 'http://127.0.0.1:4100';
const cloudPlane = 'https://plane.example';

const installationId = '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30';

/**
 * The session state machine as this component uses it: `ensureFreshSession` on
 * a socket that was refused, and `recordLatencySample` on every pong. Both
 * transcripts are held rather than counted, because the claims are about which
 * plane reached for them and how often.
 */
function sessionStub(refreshes: string[], latencies: number[] = []): ControlPlaneSession {
  return {
    ensureFreshSession: async () => {
      refreshes.push('called');
      return true;
    },
    recordLatencySample: (roundTripMs: number) => latencies.push(roundTripMs),
  } as unknown as ControlPlaneSession;
}

/** The parts of a `WebSocket` `RealtimeClient` drives, as a test can drive them. */
interface FakeRealtimeSocket {
  readonly url: string;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

/**
 * Every realtime socket the runtime opened, with the browser's constructor
 * replaced.
 *
 * The constructor and not an injected factory: what is under test is the
 * composition this component builds, and it injects no factory, so a socket
 * handed in through one would be a socket this code path never opens.
 */
function recordRealtimeSockets(): FakeRealtimeSocket[] {
  const sockets: FakeRealtimeSocket[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      binaryType = '';
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { readonly data: unknown }) => void) | null = null;
      onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
      }

      send(): void {}

      close(): void {
        this.readyState = 3;
      }
    },
  );
  return sockets;
}

/** A pong as the hub answers a ping: the client's own reading, echoed back. */
function pongBytes(clientMonotonicMs: number): ArrayBuffer {
  const frame = create(realtimeV1.RealtimeServerFrameSchema, {
    payload: {
      case: 'pong',
      value: {
        clientMonotonicMs: BigInt(clientMonotonicMs),
        serverTime: timestampFromDate(new Date(1_700_000_000_000)),
      },
    },
  });
  return toBinary(realtimeV1.RealtimeServerFrameSchema, frame).buffer as ArrayBuffer;
}

/**
 * Every address the runtime reached, in order.
 *
 * The clients are built with real transports rather than injected RPC clients,
 * because the claim under test is *which plane* a collaborator was built
 * against, and an injected client has no address at all. Every call is refused
 * with `503`, which is what an unreachable plane answers; the transcript is
 * what the assertions read.
 */
function recordFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return new Response(null, { status: 503 });
    }),
  );
  return urls;
}

function linkState(overrides: Partial<ControlPlaneLinkState>): ControlPlaneLinkState {
  return {
    linkId: 'link-0',
    baseUrl: nearPlane,
    role: 'primary',
    admitted: true,
    delivery: 'poll',
    status: 'off',
    connectionId: '',
    lastSequence: 0,
    resyncCount: 0,
    ...overrides,
  };
}

/** A device holding both planes, with a paired session both may present. */
function twoLinks(): { readonly links: readonly ControlPlaneLink[] } {
  const sessionStore = new DeviceSessionStore(memoryStorage());
  sessionStore.write({
    version: 3,
    pairedAtUrl: nearPlane,
    controlPlaneInstallationId: installationId,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: Date.now() + 600_000,
    refreshTokenExpiresAt: Date.now() + 6_000_000,
    deviceId: 'device-a',
    groupId: 'group-a',
    role: 'EDITOR',
  });
  return {
    links: [
      {
        linkId: 'link-0',
        baseUrl: nearPlane,
        role: 'primary',
        client: new ControlPlaneClient({ baseUrl: nearPlane, sessionStore, credentials: 'owner' }),
      },
      {
        linkId: 'link-1',
        baseUrl: cloudPlane,
        role: 'secondary',
        client: new ControlPlaneClient({
          baseUrl: cloudPlane,
          sessionStore,
          credentials: 'reader',
        }),
      },
    ],
  };
}

function joinGroup(links: readonly ControlPlaneLinkState[]): void {
  act(() => {
    operationsStore.getState().patchConnection({
      mode: 'online',
      session: { deviceId: 'device-a', groupId: 'group-a', role: 'EDITOR' },
      capabilities: {
        installationId,
        sync: true,
        deviceLifecycle: true,
        realtimeAdmission: false,
        settings: true,
        materials: false,
      },
      links,
    });
  });
}

/**
 * Lets the mount effect run and the feeds take their first tick.
 *
 * A real macrotask and not three microtasks: `GroupEventPoller` arms a
 * `setTimeout` for its first read, and a test that only flushed promises would
 * assert that nothing was asked -- which every one of these cases would then
 * pass for the wrong reason.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe('GroupChannelRuntime over two planes of one group', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows every admitted plane and asks each of them for the log', async () => {
    const urls = recordFetch();
    const { links } = twoLinks();
    joinGroup([
      linkState({}),
      linkState({ linkId: 'link-1', baseUrl: cloudPlane, role: 'secondary' }),
    ]);

    render(<GroupChannelRuntime links={links} session={sessionStub([])} />);
    await settle();

    // Both planes carry the same durable log out of the same database, so both
    // are read; the channel is what makes an event that arrived twice apply
    // once.
    expect(urls.some((url) => url.startsWith(nearPlane) && url.includes('ReadGroupEvents'))).toBe(
      true,
    );
    expect(urls.some((url) => url.startsWith(cloudPlane) && url.includes('ReadGroupEvents'))).toBe(
      true,
    );
  });

  it('never reads or publishes to a plane answering for a different database', async () => {
    const urls = recordFetch();
    const { links } = twoLinks();
    joinGroup([
      linkState({}),
      linkState({ linkId: 'link-1', baseUrl: cloudPlane, role: 'secondary', admitted: false }),
    ]);

    render(<GroupChannelRuntime links={links} session={sessionStub([])} />);
    await settle();

    /*
     * Two databases share no sequence allocator, no token table and no
     * receipts. Merging the second log into this cursor would drop every other
     * event as already applied, so the link is held, shown, and asked nothing.
     */
    expect(urls.some((url) => url.startsWith(nearPlane))).toBe(true);
    expect(urls.filter((url) => url.startsWith(cloudPlane))).toEqual([]);
  });

  it('builds the group settings on the primary plane and on no other', async () => {
    const urls = recordFetch();
    const { links } = twoLinks();
    joinGroup([
      linkState({}),
      linkState({ linkId: 'link-1', baseUrl: cloudPlane, role: 'secondary' }),
    ]);

    render(<GroupChannelRuntime links={links} session={sessionStub([])} />);
    await settle();

    /*
     * `GroupSettingsSync` overwrites this machine's draft with the group's
     * values on join. Two of them against two planes would be two writers of
     * one draft, racing over the same values, so exactly one is built and it is
     * the primary link's.
     */
    const settingsCalls = urls.filter((url) => url.includes('GetEffectiveSettings'));
    expect(settingsCalls).toHaveLength(1);
    expect(settingsCalls[0]?.startsWith(nearPlane)).toBe(true);
  });

  it('moves publication to the cloud plane while the near one is not carrying, and back', async () => {
    const urls = recordFetch();
    const { links } = twoLinks();
    joinGroup([
      linkState({ status: 'polling' }),
      linkState({
        linkId: 'link-1',
        baseUrl: cloudPlane,
        role: 'secondary',
        status: 'polling',
      }),
    ]);

    render(<GroupChannelRuntime links={links} session={sessionStub([])} />);
    await settle();
    const channel = currentGroupRuntime()?.channel;
    if (channel === undefined) throw new Error('The group runtime holds no channel.');

    const publishedTo = async (): Promise<string | undefined> => {
      const before = urls.length;
      // Every plane refuses with `503` here; where the call went is the claim,
      // and the failure is what a call to an unreachable plane looks like.
      await channel
        .publishSessionCommand({ action: 'play', target: 'wall-1' })
        .catch(() => undefined);
      return urls.slice(before).find((url) => url.includes('PublishSessionCommand'));
    };
    const setStatus = (linkId: string, status: ControlPlaneLinkState['status']) => {
      act(() => {
        const state = operationsStore.getState();
        state.patchConnection({
          links: state.connection.links.map((link) =>
            link.linkId === linkId ? { ...link, status } : link,
          ),
        });
      });
    };

    expect(await publishedTo()).toContain(nearPlane);

    /*
     * The near plane's socket dropped. The switch is safe because both planes
     * stand in front of one database and a repeated mutation is answered by its
     * receipt; and it costs nothing, because the plane is chosen at the moment
     * of the call rather than when the channel was built. A status change does
     * not rebuild the feeds, which is why the channel here is still the same
     * object.
     */
    setStatus('link-0', 'reconnecting');
    expect(await publishedTo()).toContain(cloudPlane);

    setStatus('link-0', 'polling');
    expect(await publishedTo()).toContain(nearPlane);
    expect(currentGroupRuntime()?.channel).toBe(channel);
  });

  it('measures the round trip on the primary plane socket and on no other', async () => {
    recordFetch();
    const sockets = recordRealtimeSockets();
    const latencies: number[] = [];
    const { links } = twoLinks();
    joinGroup([
      linkState({ delivery: 'socket' }),
      linkState({
        linkId: 'link-1',
        baseUrl: cloudPlane,
        role: 'secondary',
        delivery: 'socket',
      }),
    ]);

    render(<GroupChannelRuntime links={links} session={sessionStub([], latencies)} />);
    await settle();

    const near = sockets.find((socket) => socket.url.startsWith('ws://127.0.0.1:4100'));
    const cloud = sockets.find((socket) => socket.url.startsWith('wss://plane.example'));
    if (near === undefined || cloud === undefined) {
      throw new Error('Both planes were expected to open a realtime socket.');
    }

    const sentMs = Date.now() - 24;
    near.onmessage?.({ data: pongBytes(sentMs) });
    cloud.onmessage?.({ data: pongBytes(sentMs) });

    /*
     * One sample, from the near plane. `connection.clock` is the estimate
     * against the plane `ControlPlaneSession` holds, and the cloud plane's
     * round trip is a different path through a different network: folding both
     * into one median would report a link that is neither of them.
     */
    expect(latencies).toHaveLength(1);
    expect(latencies[0]).toBeGreaterThanOrEqual(24);
    // The socket carried the ping's own reading, so the figure is the elapsed
    // time and not the age of the epoch.
    expect(latencies[0]).toBeLessThan(5_000);
  });

  it('asks the session to refresh from no feed of its own accord', async () => {
    const refreshes: string[] = [];
    recordFetch();
    const { links } = twoLinks();
    joinGroup([
      linkState({}),
      linkState({ linkId: 'link-1', baseUrl: cloudPlane, role: 'secondary' }),
    ]);

    render(<GroupChannelRuntime links={links} session={sessionStub(refreshes)} />);
    await settle();

    // Rotation is single-writer. A feed that reached for it would be a second
    // minter of refresh request ids against one stored token, which the server
    // reads as a stolen-token replay.
    expect(refreshes).toEqual([]);
  });
});

describe('the group own state, as the operator sees it', () => {
  /**
   * The near plane, answering `ReadGroupEvents` with real generated messages.
   *
   * RPC clients are injected rather than a `fetch` stubbed, because what is
   * under test here runs the whole client path -- the generated `GroupEvent`,
   * the codec, the poll feed, the channel's cursor, the subscriber and the
   * store -- and a hand-rolled envelope would skip the first two of those.
   */
  function planeServing(
    events: readonly syncV1.GroupEvent[],
    overrides: Partial<SyncRpcClient> = {},
  ): {
    readonly links: readonly ControlPlaneLink[];
    readonly reads: bigint[];
    readonly client: ControlPlaneClient;
  } {
    const sessionStore = new DeviceSessionStore(memoryStorage());
    sessionStore.write({
      version: 3,
      pairedAtUrl: nearPlane,
      controlPlaneInstallationId: installationId,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 6_000_000,
      deviceId: 'device-a',
      groupId: 'group-a',
      role: 'ADMIN',
    });
    const reads: bigint[] = [];
    const sync = {
      readGroupEvents: (request: { readonly afterSequence: bigint }) => {
        reads.push(request.afterSequence);
        return Promise.resolve({
          events: events.filter((event) => event.sequence > request.afterSequence),
          earliestAvailableSequence: events[0]?.sequence ?? 0n,
          hasMore: false,
          resyncRequired: false,
        });
      },
      ...overrides,
    } as unknown as SyncRpcClient;
    const control = {} as unknown as ControlRpcClient;
    const client = new ControlPlaneClient({
      baseUrl: nearPlane,
      sessionStore,
      credentials: 'owner',
      clients: { control, sync },
    });
    return {
      reads,
      client,
      links: [{ linkId: 'link-0', baseUrl: nearPlane, role: 'primary', client }],
    };
  }

  function leaderMoved(sequence: bigint, leaderDeviceId: string, revision: bigint) {
    return create(syncV1.GroupEventSchema, {
      sequence,
      kind: syncV1.GroupEventKind.GROUP_UPDATED,
      actorDeviceId: { value: 'device-b' },
      occurredAt: timestampFromDate(new Date()),
      group: {
        id: { value: 'group-a' },
        name: 'ШТАБ',
        authorityMode: syncV1.AuthorityMode.LEADER,
        leaderDeviceId: { value: leaderDeviceId },
        revision: { number: revision, etag: `group-a-${revision.toString()}` },
      },
    });
  }

  /** The group as `JoinGroup` left it: two devices, the first of them leading. */
  function joined(links: readonly ControlPlaneLinkState[]): void {
    act(() => {
      operationsStore.getState().patchConnection({
        mode: 'online',
        session: { deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' },
        capabilities: {
          installationId,
          sync: true,
          deviceLifecycle: true,
          realtimeAdmission: false,
          settings: false,
          materials: false,
        },
        groupName: 'ШТАБ',
        authority: 'leader',
        leaderDeviceId: 'device-a',
        groupRevision: 7,
        devices: [
          { deviceId: 'device-a', name: 'ЭКРАН 1', role: 'ADMIN', status: 'ONLINE' },
          { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'EDITOR', status: 'ONLINE' },
        ],
        links,
      });
    });
  }

  /** Which device the pairing surface prints the leader mark against. */
  function leaderOnScreen(): string | undefined {
    const marked = [...document.querySelectorAll('.group-pairing__devices article')].find(
      (entry) => entry.querySelector('small')?.textContent?.includes('· ГЛАВНАЯ') === true,
    );
    return marked?.querySelector('strong')?.textContent ?? undefined;
  }

  it('moves the leader mark a session never asked for, without reconnecting', async () => {
    const { links, reads } = planeServing([leaderMoved(1n, 'device-b', 8n)]);
    joined([linkState({})]);

    render(
      <>
        <GroupChannelRuntime links={links} session={sessionStub([])} />
        <GroupPairingDialog />
      </>,
    );
    act(() => {
      openGroupPairing();
    });
    expect(leaderOnScreen()).toBe('ЭКРАН 1');

    await settle();

    /*
     * Nothing here reconnected, rejoined or called `SetLeader`: the only
     * request the session made is the page of the log it was already reading.
     * That page is what moved the mark, and before the subscriber existed it
     * was decoded and dropped.
     */
    expect(reads).toEqual([0n]);
    expect(leaderOnScreen()).toBe('ЭКРАН 2');
    expect(operationsStore.getState().connection.leaderDeviceId).toBe('device-b');
  });

  it('leaves the mark where it is when the page replays an older revision', async () => {
    const { links } = planeServing([leaderMoved(1n, 'device-c', 4n)]);
    joined([linkState({})]);

    render(
      <>
        <GroupChannelRuntime links={links} session={sessionStub([])} />
        <GroupPairingDialog />
      </>,
    );
    act(() => {
      openGroupPairing();
    });
    await settle();

    // The session joined at revision 7. A snapshot from revision 4 is a page of
    // the retained window and not news, whatever order it arrived in.
    expect(leaderOnScreen()).toBe('ЭКРАН 1');
    expect(operationsStore.getState().connection.leaderDeviceId).toBe('device-a');
  });
  /** The group renamed elsewhere, at a revision this session has not seen. */
  function groupRenamed(sequence: bigint, name: string, revision: bigint) {
    return create(syncV1.GroupEventSchema, {
      sequence,
      kind: syncV1.GroupEventKind.GROUP_UPDATED,
      actorDeviceId: { value: 'device-b' },
      occurredAt: timestampFromDate(new Date()),
      group: {
        id: { value: 'group-a' },
        name,
        authorityMode: syncV1.AuthorityMode.LEADER,
        leaderDeviceId: { value: 'device-a' },
        revision: { number: revision, etag: `group-a-${revision.toString()}` },
      },
    });
  }

  /** This device's role, changed by an administrator on another machine. */
  function devicePromoted(sequence: bigint, revision: bigint) {
    return create(syncV1.GroupEventSchema, {
      sequence,
      kind: syncV1.GroupEventKind.DEVICE_UPDATED,
      actorDeviceId: { value: 'device-b' },
      occurredAt: timestampFromDate(new Date()),
      group: {
        id: { value: 'group-a' },
        name: 'ШТАБ',
        authorityMode: syncV1.AuthorityMode.MULTI_AUTHORITY,
        leaderDeviceId: { value: 'device-b' },
        revision: { number: revision, etag: `group-a-${revision.toString()}` },
      },
      device: {
        id: { value: 'device-a' },
        name: 'ЭКРАН 1',
        role: syncV1.DeviceRole.ADMIN,
        status: syncV1.DeviceStatus.ONLINE,
      },
    });
  }

  /** What the pairing surface prints beside a term of its summary list. */
  function summaryValue(term: string): string | undefined {
    const row = [...document.querySelectorAll('.ops-definition-list > div')].find(
      (entry) => entry.querySelector('dt')?.textContent === term,
    );
    return row?.querySelector('dd')?.textContent ?? undefined;
  }

  it('keeps a rename the retained window would otherwise undo', async () => {
    /*
     * The page the feed replays from a cursor of zero is a real snapshot of
     * this group -- an earlier mutation this session never saw -- and it is
     * older than the rename that has just been made. What tells them apart is
     * the revision the rename came back with, and nothing else can: arrival
     * order puts the older one last.
     */
    const { links, client } = planeServing([groupRenamed(1n, 'ШТАБ', 7n)], {
      updateGroup: (request: { readonly name: string }) =>
        Promise.resolve({
          group: {
            id: { value: 'group-a' },
            name: request.name,
            authorityMode: syncV1.AuthorityMode.LEADER,
            leaderDeviceId: { value: 'device-a' },
            revision: { number: 8n },
          },
        }),
    });
    joined([linkState({})]);
    act(() => {
      operationsStore.getState().patchConnection({ groupRevision: 6 });
    });
    const created = new ControlPlaneSession({
      client,
      apply: (patch) => operationsStore.getState().patchConnection(patch),
    });

    await act(async () => {
      await created.renameGroup('ШТАБ-2');
    });
    render(
      <>
        <GroupChannelRuntime links={links} session={sessionStub([])} />
        <GroupPairingDialog />
      </>,
    );
    act(() => {
      openGroupPairing();
    });
    await settle();

    // The name the operator typed is still the name on screen after the whole
    // retained window has been replayed over it.
    expect(summaryValue('ГРУППА')).toBe('ШТАБ-2');
    expect(operationsStore.getState().connection.groupRevision).toBe(8);
  });

  it('raises this session own role when an administrator elsewhere promotes it', async () => {
    const { links, reads } = planeServing([devicePromoted(1n, 8n)]);
    joined([linkState({})]);
    act(() => {
      operationsStore.getState().patchConnection({
        session: { deviceId: 'device-a', groupId: 'group-a', role: 'EDITOR' },
        devices: [
          { deviceId: 'device-a', name: 'ЭКРАН 1', role: 'EDITOR', status: 'ONLINE' },
          { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'ADMIN', status: 'ONLINE' },
        ],
      });
    });

    render(<GroupChannelRuntime links={links} session={sessionStub([])} />);
    await settle();

    /*
     * The role every administrative control is gated on, moved by a page of the
     * log and by nothing else: no rejoin, no `ListDevices`, no reconnection.
     * A session that went on believing the role it paired with would keep the
     * commands the server has just started allowing it out of reach.
     */
    expect(reads).toEqual([0n]);
    expect(operationsStore.getState().connection.session?.role).toBe('ADMIN');
    expect(operationsStore.getState().connection.devices).toEqual([
      { deviceId: 'device-a', name: 'ЭКРАН 1', role: 'ADMIN', status: 'ONLINE' },
      { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'ADMIN', status: 'ONLINE' },
    ]);
  });
});
