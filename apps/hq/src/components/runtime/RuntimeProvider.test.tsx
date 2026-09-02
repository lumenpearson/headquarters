// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const updateRuntime = vi.hoisted(() => ({ startLaunchUpdateCheck: vi.fn() }));
vi.mock('@/application/update/appUpdateRuntime', () => updateRuntime);

vi.mock('@/application/RuntimeController', () => ({
  RuntimeController: {
    create: vi.fn().mockResolvedValue({ close: vi.fn(), toggleDeveloper: vi.fn() }),
  },
}));

import { LaunchUpdateCheck, RuntimeProvider } from './RuntimeProvider';

afterEach(() => {
  cleanup();
  updateRuntime.startLaunchUpdateCheck.mockClear();
});

/*
 * Item 3: the launch check must run once per launch, not once per webview.
 * `RuntimeProvider` is mounted by four roots, three of which are separate
 * Tauri windows onto the same running session (`ScreenView`, `WallView`,
 * `DeveloperGate`); only `OperationalShell` renders `LaunchUpdateCheck`
 * alongside it. These trees stand in for "the shell" and "an auxiliary
 * root" without pulling in either component's own heavy dependencies.
 */
describe('LaunchUpdateCheck', () => {
  it('runs the launch check once the runtime is ready, for a tree that renders it -- the shell root', async () => {
    render(
      <RuntimeProvider>
        <LaunchUpdateCheck />
      </RuntimeProvider>,
    );

    await waitFor(() => expect(updateRuntime.startLaunchUpdateCheck).toHaveBeenCalledTimes(1));
  });

  it('never runs the launch check for a tree that does not render it -- standing in for an auxiliary root', async () => {
    render(
      <RuntimeProvider>
        <div>auxiliary window content</div>
      </RuntimeProvider>,
    );

    // Let the mock controller's promise, and any effect it wakes, settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateRuntime.startLaunchUpdateCheck).not.toHaveBeenCalled();
  });
});
