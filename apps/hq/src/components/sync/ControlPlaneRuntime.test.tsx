// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearManualControlPlaneAddress,
  writeManualControlPlaneAddress,
} from '@/application/sync/manualControlPlaneAddress';
import {
  ControlPlaneClient,
  type ControlRpcClient,
  type SyncRpcClient,
} from '@/infrastructure/controlPlane/ControlPlaneClient';
import {
  DeviceSessionStore,
  memoryStorage,
} from '@/infrastructure/controlPlane/DeviceSessionStore';
import { groupMirrorStorageKey } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { operationsStore } from '@/state/operationsStore';

import {
  attemptPlaneFailover,
  ControlPlaneRuntime,
  currentControlPlaneLinks,
  type ControlPlaneLink,
} from './ControlPlaneRuntime';

/** Lets the mount effect's promise chain settle before the assertion. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ControlPlaneRuntime', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.getState().patchConnection({ mode: 'connecting' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('touches nothing on a fresh profile, where general.localOnly is on', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<ControlPlaneRuntime />);
    await settle();

    /*
     * The setting defaults to on, so an installation nobody has configured
     * makes no request of any kind -- not even for the runtime configuration
     * that would tell it where a control plane is. Holding `fetch` itself is
     * the only way to state that: a spy on the client would pass while the
     * runtime read the address it was told not to want.
     */
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(operationsStore.getState().connection.mode).toBe('local-only');
  });

  it('stays local-only when nothing configures a control plane address', async () => {
    // The committed default ships without `controlPlaneUrl`; the override is
    // absent on a machine nobody has set up.
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/runtime/project.override.json') return new Response(null, { status: 404 });
      return new Response(JSON.stringify(projectDefault), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });

    render(<ControlPlaneRuntime />);
    await settle();

    // No address is the same fact as local-only: there is no group to be out of.
    expect(operationsStore.getState().connection.mode).toBe('local-only');
    // And no link is held, which is what the status line prints as a single
    // `OFF` rather than as a set.
    expect(operationsStore.getState().connection.links).toEqual([]);
  });
});

describe('ControlPlaneRuntime and the addresses a group answers at', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.getState().patchConnection({ mode: 'connecting' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Serves the committed default with the override an operator would write. */
  function configure(values: Readonly<Record<string, unknown>>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/runtime/project.override.json') {
          return new Response(JSON.stringify({ version: 1, values, assetOverrides: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === '/runtime/project.default.json') {
          return new Response(JSON.stringify(projectDefault), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // The probe. Nothing here is a control plane, so it answers as an
        // unreachable one would; what is under test is the link set, which is
        // installed before anything is asked.
        return new Response(null, { status: 503 });
      }),
    );
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });
  }

  it('holds one link for one address, exactly as it did before there was a set', async () => {
    configure({ controlPlaneUrl: nearPlane });

    render(<ControlPlaneRuntime />);
    await settle();

    // The regression guard for every installation that has no second plane:
    // one address is one primary link and nothing else changed.
    expect(operationsStore.getState().connection.links).toMatchObject([
      { linkId: 'link-0', baseUrl: nearPlane, role: 'primary', admitted: true },
    ]);
    expect(currentControlPlaneLinks().map((link) => link.client.credentials)).toEqual(['owner']);
  });

  it('holds one link per address, in the order the operator wrote them', async () => {
    configure({ controlPlaneUrl: [nearPlane, cloudPlane] });

    render(<ControlPlaneRuntime />);
    await settle();

    /*
     * The plane on the set's LAN and the plane on the internet, in front of one
     * database. The first is the primary: the session runs on it and it is the
     * only client permitted to rotate the refresh token, because two clients
     * minting request ids against one stored token would be read by the server
     * as a stolen-token replay.
     */
    expect(operationsStore.getState().connection.links).toMatchObject([
      { linkId: 'link-0', baseUrl: nearPlane, role: 'primary' },
      { linkId: 'link-1', baseUrl: cloudPlane, role: 'secondary' },
    ]);
    // Exactly one client may write the shared credentials. Two of them minting
    // refresh request ids against one stored token is what the server reads as
    // a stolen-token replay, and it answers by revoking the session family.
    expect(currentControlPlaneLinks().map((link) => link.client.credentials)).toEqual([
      'owner',
      'reader',
    ]);
  });

  it('keeps the addresses on show once the session is out of the group', async () => {
    configure({ controlPlaneUrl: [nearPlane, cloudPlane] });

    render(<ControlPlaneRuntime />);
    await settle();
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'offline' });
    });

    // The addresses are a fact about the configuration and do not stop existing
    // because a probe failed -- an operator looking at an offline screen is
    // looking for exactly them.
    expect(operationsStore.getState().connection.links.map((link) => link.baseUrl)).toEqual([
      nearPlane,
      cloudPlane,
    ]);
  });
});

describe('ControlPlaneRuntime and the local copy of the group', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.getState().patchConnection({ mode: 'connecting' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function draftValue(id: string): unknown {
    return operationsStore.getState().personalization.draft.values[id];
  }

  /** The copy one successful synchronization would have left on disk. */
  function storeMirror(values: Readonly<Record<string, unknown>>): void {
    localStorage.setItem(
      groupMirrorStorageKey,
      JSON.stringify({
        version: 1,
        groupId: 'GRP-1',
        installationId: 'INST-1',
        revision: 7,
        sequence: 12,
        values,
        refreshedAt: '2026-08-26T09:00:00.000Z',
      }),
    );
  }

  it('comes up on the compiled-in constants and then on the copy, once offline', async () => {
    storeMirror({ 'telemetry.source': 'native' });

    render(<ControlPlaneRuntime />);
    await settle();

    /*
     * `general.localOnly` defaults to on, so this launch is local-only: the
     * copy is reported but not adopted, because the operator has said this
     * machine is not in a group. The draft still holds what
     * `createFactorySnapshot()` put there.
     */
    expect(draftValue('telemetry.source')).toBe('simulation');
    expect(operationsStore.getState().connection.mirror).toEqual({
      refreshedAt: '2026-08-26T09:00:00.000Z',
      revision: 7,
      sequence: 12,
    });

    /*
     * The control plane did not answer the probe. That is what joining looks
     * like to a device that cannot reach its group, so the copy is adopted --
     * the second level of the seniority, above the constants and below a live
     * answer. The mode is moved directly because the mode is this effect's
     * input; how a probe fails is `ControlPlaneSession`'s subject.
     */
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'offline' });
    });

    expect(draftValue('telemetry.source')).toBe('native');
  });

  it('stays on the compiled-in constants when there is no copy at all', async () => {
    render(<ControlPlaneRuntime />);
    await settle();
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'offline' });
    });

    expect(draftValue('telemetry.source')).toBe('simulation');
    expect(operationsStore.getState().connection.mirror).toEqual({
      refreshedAt: '',
      revision: 0,
      sequence: 0,
    });
  });

  it('reads a hand-edited copy as no copy and changes nothing', async () => {
    // Editable in a browser's devtools, which is what makes this key a trust
    // boundary. `parseGroupMirror` re-checks every value, so a setting past its
    // own validator takes the whole blob with it rather than the draft.
    storeMirror({ 'telemetry.source': 'quantum' });

    render(<ControlPlaneRuntime />);
    await settle();
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'offline' });
    });

    expect(draftValue('telemetry.source')).toBe('simulation');
    expect(operationsStore.getState().connection.mirror.refreshedAt).toBe('');
    // The blob is left where it is: reading is not the moment to write.
    expect(localStorage.getItem(groupMirrorStorageKey)).not.toBeNull();
  });

  it('does not adopt the copy while the address answers with another database', async () => {
    storeMirror({ 'telemetry.source': 'native' });

    render(<ControlPlaneRuntime />);
    await settle();
    /*
     * `installation-changed` states that the database behind the address is not
     * the one this device paired against. Nothing local is overwritten in that
     * mode until the operator decides, and adopting the copy would be a
     * decision taken for them.
     */
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'installation-changed' });
    });

    expect(draftValue('telemetry.source')).toBe('simulation');
    // The copy is still reported, because it is still on the disk.
    expect(operationsStore.getState().connection.mirror.revision).toBe(7);
  });
});

describe('ControlPlaneRuntime and the manual address', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.getState().patchConnection({ mode: 'connecting' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('tries the manual address before reading the project file or the build variable', async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL) => new Response(null, { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    writeManualControlPlaneAddress(cloudPlane);
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });

    render(<ControlPlaneRuntime />);
    await settle();

    // The operator's own entry is checked first: neither the runtime
    // configuration nor the build variable is worth a round trip once it
    // answers. Any call the mounted client itself makes afterwards -- probing
    // the address it resolved to -- is expected and is not one of these two.
    const runtimeConfigCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : String(input);
      return url.includes('/runtime/project.');
    });
    expect(runtimeConfigCalls).toEqual([]);
    expect(operationsStore.getState().connection.links).toMatchObject([
      { linkId: 'link-0', baseUrl: cloudPlane, role: 'primary' },
    ]);
    expect(operationsStore.getState().connection.addressSource).toBe('manual');
  });

  it('re-resolves once the manual address changes after mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/runtime/project.override.json') return new Response(null, { status: 404 });
        if (url === '/runtime/project.default.json') {
          return new Response(JSON.stringify({ ...projectDefault, controlPlaneUrl: nearPlane }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 503 });
      }),
    );
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });

    render(<ControlPlaneRuntime />);
    await settle();

    expect(operationsStore.getState().connection.links).toMatchObject([{ baseUrl: nearPlane }]);
    expect(operationsStore.getState().connection.addressSource).toBe('project-file');

    act(() => {
      writeManualControlPlaneAddress(cloudPlane);
    });
    await settle();

    // The manual entry now outranks the project file this device was already
    // connected through -- the operator's most recent, explicit statement.
    expect(operationsStore.getState().connection.links).toMatchObject([{ baseUrl: cloudPlane }]);
    expect(operationsStore.getState().connection.addressSource).toBe('manual');
  });

  it('falls back to the build variable once the manual address is cleared', async () => {
    vi.stubEnv('NEXT_PUBLIC_HQ_CONTROL_PLANE_URL', cloudPlane);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/runtime/project.override.json') return new Response(null, { status: 404 });
        if (url === '/runtime/project.default.json') {
          return new Response(JSON.stringify(projectDefault), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 503 });
      }),
    );
    writeManualControlPlaneAddress(nearPlane);
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });

    render(<ControlPlaneRuntime />);
    await settle();

    expect(operationsStore.getState().connection.addressSource).toBe('manual');

    act(() => {
      clearManualControlPlaneAddress();
    });
    await settle();

    expect(operationsStore.getState().connection.links).toMatchObject([{ baseUrl: cloudPlane }]);
    expect(operationsStore.getState().connection.addressSource).toBe('build-variable');
  });
});

describe('ControlPlaneRuntime and a broken project override', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.getState().patchConnection({ mode: 'connecting' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function configureOverrideBody(body: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/runtime/project.override.json') {
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === '/runtime/project.default.json') {
          return new Response(JSON.stringify(projectDefault), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 503 });
      }),
    );
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });
  }

  it('names the override file when it holds invalid JSON, instead of asking for an address that is already there', async () => {
    configureOverrideBody('{"version":');

    render(<ControlPlaneRuntime />);
    await settle();

    expect(operationsStore.getState().connection.failure).toContain(
      '/runtime/project.override.json',
    );
    // No manual address, no working project address, no build variable: this
    // launch is genuinely local-only, and the failure line is the reason why.
    expect(operationsStore.getState().connection.mode).toBe('local-only');
  });

  it('names the override file when its controlPlaneUrl fails the schema, without swallowing the report', async () => {
    configureOverrideBody(
      JSON.stringify({ version: 1, values: { controlPlaneUrl: 'not-a-url' }, assetOverrides: {} }),
    );

    render(<ControlPlaneRuntime />);
    await settle();

    expect(operationsStore.getState().connection.failure).toContain(
      '/runtime/project.override.json',
    );
    expect(operationsStore.getState().connection.addressSource).toBe('none');
  });

  it('stays quiet about an override that simply is not there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/runtime/project.override.json') return new Response(null, { status: 404 });
        if (url === '/runtime/project.default.json') {
          return new Response(JSON.stringify(projectDefault), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 503 });
      }),
    );
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'general.localOnly', value: false }]);
    });

    render(<ControlPlaneRuntime />);
    await settle();

    // A 404 is silence, exactly as it was before this file could tell "absent"
    // from "broken" apart.
    expect(operationsStore.getState().connection.failure).toBe('');
  });
});

/*
 * Plane failover (known-limitations.md:132-138): rebuilding the session on
 * the next configured plane once the primary stops answering. Exercised
 * against `attemptPlaneFailover` directly, over real `ControlPlaneClient`
 * instances built with injected RPC clients -- the same idiom
 * `ControlPlaneClient.test.ts`'s "two links over one session store" section
 * uses -- rather than through fetch-mocked wire traffic, which is what would
 * be needed to drive a whole `connect()` through the component.
 */
describe('attemptPlaneFailover', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
  });

  /** A `SyncService` this suite never calls: `probeCapabilities` never reaches it. */
  function unreachableSyncClient(): SyncRpcClient {
    const fail = (): never => {
      throw new Error('not used by attemptPlaneFailover');
    };
    return {
      createGroup: fail,
      createPairingCode: fail,
      updateGroup: fail,
      setDeviceRole: fail,
      pairDevice: fail,
      refreshDeviceSession: fail,
      listDevices: fail,
      revokeDevice: fail,
      joinGroup: fail,
      leaveGroup: fail,
      setAuthorityMode: fail,
      setLeader: fail,
      timeSync: fail,
      getPresence: fail,
      updatePresence: fail,
      publishDocumentDelta: fail,
      publishSessionCommand: fail,
      getDocumentSnapshot: fail,
      readGroupEvents: fail,
    };
  }

  function controlRpcClient(options: {
    readonly fails?: boolean;
    readonly deviceLifecycle?: boolean;
  }): ControlRpcClient {
    return {
      async getCapabilities() {
        if (options.fails === true) throw new Error('connection refused');
        return {
          installationId: 'installation-1',
          capabilities: [
            { name: 'sync', enabled: true },
            { name: 'sync.device-lifecycle', enabled: options.deviceLifecycle ?? true },
            { name: 'sync.realtime-admission', enabled: false },
            { name: 'settings', enabled: true },
            { name: 'materials', enabled: false },
          ],
        };
      },
    };
  }

  function link(
    linkId: string,
    baseUrl: string,
    role: 'primary' | 'secondary',
    store: DeviceSessionStore,
    controlOptions: { readonly fails?: boolean; readonly deviceLifecycle?: boolean } = {},
  ): ControlPlaneLink {
    return {
      linkId,
      baseUrl,
      role,
      client: new ControlPlaneClient({
        baseUrl,
        sessionStore: store,
        credentials: role === 'primary' ? 'owner' : 'reader',
        clients: { control: controlRpcClient(controlOptions), sync: unreachableSyncClient() },
      }),
    };
  }

  it('promotes the next answering plane when the primary has stopped answering', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    const primary = link('link-0', nearPlane, 'primary', store, { fails: true });
    const secondary = link('link-1', cloudPlane, 'secondary', store);
    operationsStore
      .getState()
      .patchConnection({ links: [describeLink(primary), describeLink(secondary)] });

    const rebuilt = await attemptPlaneFailover([primary, secondary], new AbortController().signal);

    expect(rebuilt?.map((entry) => entry.linkId)).toEqual(['link-1', 'link-0']);
    // The promoted link owns the credentials; the demoted one only reads them
    // -- exactly the constraint that keeps two clients from each minting a
    // refresh request id against the one stored token.
    expect(rebuilt?.[0]?.client.credentials).toBe('owner');
    expect(rebuilt?.[1]?.client.credentials).toBe('reader');
    // The dialog's link rows read `role`, not array position, so both are
    // updated even though this array's own order never changes.
    expect(operationsStore.getState().connection.links.map((entry) => entry.role)).toEqual([
      'secondary',
      'primary',
    ]);
  });

  it('returns null and promotes nothing when every other plane is down too', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    const primary = link('link-0', nearPlane, 'primary', store, { fails: true });
    const secondary = link('link-1', cloudPlane, 'secondary', store, { fails: true });
    operationsStore
      .getState()
      .patchConnection({ links: [describeLink(primary), describeLink(secondary)] });

    const rebuilt = await attemptPlaneFailover([primary, secondary], new AbortController().signal);

    expect(rebuilt).toBeNull();
    // The local-copy exit stays intact: nothing about the roles moved.
    expect(operationsStore.getState().connection.links.map((entry) => entry.role)).toEqual([
      'primary',
      'secondary',
    ]);
  });

  it('never fails over with only one configured plane', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    const primary = link('link-0', nearPlane, 'primary', store, { fails: true });

    const rebuilt = await attemptPlaneFailover([primary], new AbortController().signal);

    expect(rebuilt).toBeNull();
  });

  it('skips a plane already known to answer for another database', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    const primary = link('link-0', nearPlane, 'primary', store, { fails: true });
    const secondary = link('link-1', cloudPlane, 'secondary', store);
    operationsStore.getState().patchConnection({
      links: [describeLink(primary), { ...describeLink(secondary), admitted: false }],
    });

    const rebuilt = await attemptPlaneFailover([primary, secondary], new AbortController().signal);

    // A link the boot-time probe already found in front of a different
    // database is never promoted, even though it does answer.
    expect(rebuilt).toBeNull();
  });

  it('does not promote a plane started without device lifecycle', async () => {
    const store = new DeviceSessionStore(memoryStorage());
    const primary = link('link-0', nearPlane, 'primary', store, { fails: true });
    const secondary = link('link-1', cloudPlane, 'secondary', store, { deviceLifecycle: false });
    operationsStore
      .getState()
      .patchConnection({ links: [describeLink(primary), describeLink(secondary)] });

    const rebuilt = await attemptPlaneFailover([primary, secondary], new AbortController().signal);

    expect(rebuilt).toBeNull();
  });
});

function describeLink(entry: ControlPlaneLink) {
  return {
    linkId: entry.linkId,
    baseUrl: entry.baseUrl,
    role: entry.role,
    admitted: true,
    delivery: 'poll' as const,
    status: 'off' as const,
    connectionId: '',
    lastSequence: 0,
    resyncCount: 0,
  };
}

/* Placeholder addresses: the plane on the set's LAN, and the cloud plane. */
const nearPlane = 'http://127.0.0.1:4100';
const cloudPlane = 'https://plane.example';

const projectDefault = {
  version: 1,
  projectName: 'Гремучая смесь — Оперативный штаб',
  buildId: 'hq-test',
  runtimeMode: 'rehearsal',
  developerAccessCode: '314159',
  defaultWallPreset: 'hq-standard',
  fixedClock: '14:32:17',
  bridgeUrl: 'http://127.0.0.1:4177',
  screenWindows: [],
  virtualMountRules: [],
  fileDisplayOverrides: [],
  freezeActiveMediaOnSourceChange: true,
  maxTextPreviewBytes: 1_048_576,
};
