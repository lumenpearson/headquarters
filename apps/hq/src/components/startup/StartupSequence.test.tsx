// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
import { startupStages } from './StartupPlan';
import { StartupSequence } from './StartupSequence';

function overlay(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.startup-sequence');
}

describe('StartupSequence', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    vi.useFakeTimers();
  });

  it('runs on mount and steps through every stage before clearing itself', () => {
    const { container } = render(<StartupSequence />);
    expect(overlay(container)?.dataset.stage).toBe(startupStages[0]);

    // 309ms per stage at the default intensity of 0.65.
    for (const stage of startupStages.slice(1)) {
      act(() => void vi.advanceTimersByTime(309));
      expect(overlay(container)?.dataset.stage).toBe(stage);
    }

    act(() => void vi.advanceTimersByTime(309));
    expect(overlay(container)).toBeNull();
  });

  it('renders nothing at all when the operator turned the sequence off', () => {
    act(() =>
      operationsStore.getState().applySettingsPatch([{ id: 'startup.enabled', value: false }]),
    );
    const { container } = render(<StartupSequence />);
    expect(overlay(container)).toBeNull();
  });

  it('keeps nothing about having run, so the next process launch plays it again', () => {
    // R16 as asked for: the sequence belongs to a process start, not to a
    // first-ever start. Persisting "already seen" anywhere -- localStorage or
    // sessionStorage -- would silence every launch after the first.
    const { container, unmount } = render(<StartupSequence />);
    act(() => void vi.advanceTimersByTime(309 * startupStages.length));
    expect(overlay(container)).toBeNull();
    unmount();

    const second = render(<StartupSequence />);
    expect(overlay(second.container)?.dataset.stage).toBe(startupStages[0]);
  });

  /*
   * `markStartupComplete` is the producer R11's keybind intro (`KeybindIntro`)
   * waits on: that consumer is tested against the flag already being true or
   * false, never against this component actually setting it. Deleting the
   * effect that calls it (StartupSequence.tsx:47-54) would leave every test
   * above green -- they only assert on the overlay disappearing -- while the
   * card never auto-opens again on any launch.
   */
  it('calls markStartupComplete straight away when the sequence does not play', () => {
    act(() =>
      operationsStore.getState().applySettingsPatch([{ id: 'startup.enabled', value: false }]),
    );
    expect(operationsStore.getState().ui.startupComplete).toBe(false);

    render(<StartupSequence />);

    expect(operationsStore.getState().ui.startupComplete).toBe(true);
  });

  it('calls markStartupComplete once every stage has played', () => {
    render(<StartupSequence />);
    expect(operationsStore.getState().ui.startupComplete).toBe(false);

    act(() => void vi.advanceTimersByTime(309 * (startupStages.length - 1)));
    expect(operationsStore.getState().ui.startupComplete).toBe(false);

    act(() => void vi.advanceTimersByTime(309));
    expect(operationsStore.getState().ui.startupComplete).toBe(true);
  });
});
