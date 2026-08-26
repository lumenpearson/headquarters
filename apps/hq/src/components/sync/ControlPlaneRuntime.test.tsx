// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
