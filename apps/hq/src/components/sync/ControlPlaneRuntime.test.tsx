// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groupMirrorStorageKey } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { operationsStore } from '@/state/operationsStore';

import { ControlPlaneRuntime, currentControlPlaneLinks } from './ControlPlaneRuntime';

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
