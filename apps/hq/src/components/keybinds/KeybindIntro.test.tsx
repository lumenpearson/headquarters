// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
import { keybindIntroStorageKey, KeybindIntro } from './KeybindIntro';

function card(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.keybind-intro');
}

describe('KeybindIntro', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
  });

  it('does not mount on a first-ever launch before StartupSequence signals it is done', () => {
    // Empty storage: no seen flag, `keybinds.introOnLaunch` at its default of
    // true, and `startupComplete` at its own default of false -- the state
    // the application is in for the whole time the boot readout is playing.
    const { container } = render(<KeybindIntro />);
    expect(card(container)).toBeNull();
  });

  it('mounts once startup signals it is done, on a first-ever launch', () => {
    const { container } = render(<KeybindIntro />);
    expect(card(container)).toBeNull();

    act(() => operationsStore.getState().markStartupComplete());

    expect(card(container)).not.toBeNull();
  });

  it('stays suppressed after startup when the seen flag is already set', () => {
    localStorage.setItem(keybindIntroStorageKey, new Date().toISOString());
    act(() => operationsStore.getState().markStartupComplete());

    const { container } = render(<KeybindIntro />);
    expect(card(container)).toBeNull();
  });

  /*
   * The card used to be present from first paint, so nothing before it could
   * ever hold focus. Gating it on `startupComplete` (an arbitrary timer, not
   * a mount) means it can now appear while the operator is already focused
   * somewhere else -- a plain `role="dialog"` with no focus management would
   * leave that focus stranded behind the scrim.
   */
  it('is a modal dialog that moves focus onto the card, and returns it on dismiss', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    try {
      const { container } = render(<KeybindIntro />);
      act(() => operationsStore.getState().markStartupComplete());

      const dialog = card(container);
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      const cardElement = container.querySelector('.keybind-intro__card');
      expect(cardElement).not.toBeNull();
      expect(document.activeElement).toBe(cardElement);

      const dismissButton = cardElement?.querySelector('footer button');
      expect(dismissButton).not.toBeNull();
      act(() => (dismissButton as HTMLElement).click());

      expect(card(container)).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });
});
