// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groupMirrorStorageKey } from '@/infrastructure/controlPlane/GroupSnapshotDownloader';
import { operationsStore } from '@/state/operationsStore';

import { ControlPlaneRuntime } from './ControlPlaneRuntime';

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
