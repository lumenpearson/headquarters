// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { appStore } from '@/state/appStore';

import { TopBar } from './TopBar';

afterEach(() => {
  cleanup();
});

/** Marks every screen frozen/blacked-out, or resets the flags -- FREEZE and
 * BLACKOUT are scene-wide cue actions, so the accounting reads the whole map. */
function setScreensFlag(flag: 'frozen' | 'blackout', value: boolean): void {
  act(() => {
    const state = appStore.getState();
    const byId = Object.fromEntries(
      Object.entries(state.screens.byId).map(([id, screen]) => [id, { ...screen, [flag]: value }]),
    );
    appStore.getState().replaceRuntimeState({ ...state, screens: { byId } } as typeof state);
  });
}

describe('R? FREEZE/BLACKOUT are one-way from this bar; the buttons reflect the active state instead of toggling', () => {
  it('marks FREEZE pressed once any screen is frozen, and not otherwise', () => {
    render(<TopBar />);
    const button = screen.getByRole('button', { name: 'FREEZE' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).not.toContain('is-active');

    setScreensFlag('frozen', true);

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('is-active');

    setScreensFlag('frozen', false);
  });

  it('marks BLACKOUT pressed once any screen is blacked out, and not otherwise', () => {
    render(<TopBar />);
    const button = screen.getByRole('button', { name: 'BLACKOUT' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).not.toContain('is-active');

    setScreensFlag('blackout', true);

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('is-active');

    setScreensFlag('blackout', false);
  });
});
