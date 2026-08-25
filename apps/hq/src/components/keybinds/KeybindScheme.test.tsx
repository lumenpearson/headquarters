// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { KeybindList } from './KeybindList';
import { KeybindRuntime, useKeybind } from './KeybindRuntime';

function Subscriber({ id, onFire }: { readonly id: string; readonly onFire: () => void }) {
  useKeybind(id, onFire);
  return null;
}

function chooseScheme(scheme: string): void {
  operationsStore.getState().applySettingsPatch([{ id: 'keybinds.scheme', value: scheme }]);
}

function press(init: KeyboardEventInit & { code: string }, target?: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(event);
  return event;
}

describe('keybinds.scheme', () => {
  beforeEach(() => {
    // resetWorld rebuilds from the base state, which brings the personalization
    // draft back to the schema's defaults -- `terminal-default` among them.
    operationsStore.getState().resetWorld();
    document.body.innerHTML = '';
  });

  it('reaches a route by its digit under the default collection', () => {
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="navigate.objects" onFire={fired} />
      </>,
    );
    press({ code: 'Digit2' });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('reaches the same route through g and the digit under the vim collection', () => {
    chooseScheme('vim-inspired');
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="navigate.objects" onFire={fired} />
      </>,
    );

    // The digit alone is no longer a chord: the vim collection spends it on
    // the second half of a sequence.
    press({ code: 'Digit2' });
    expect(fired).not.toHaveBeenCalled();

    press({ code: 'KeyG' });
    press({ code: 'Digit2' });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('forgets a prefix that led nowhere rather than carrying it forward', () => {
    chooseScheme('vim-inspired');
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="navigate.objects" onFire={fired} />
      </>,
    );
    press({ code: 'KeyG' });
    press({ code: 'KeyX' });
    press({ code: 'Digit2' });
    expect(fired).not.toHaveBeenCalled();
  });

  it('still dismisses while a prefix is open, so no overlay can be trapped', () => {
    chooseScheme('vim-inspired');
    const dismissed = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.dismiss" onFire={dismissed} />
      </>,
    );
    press({ code: 'KeyG' });
    press({ code: 'Escape' });
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('opens edit mode with a bare i under the vim collection and not with Ctrl+Shift+E', () => {
    chooseScheme('vim-inspired');
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="edit.toggle" onFire={fired} />
      </>,
    );
    press({ code: 'KeyE', ctrlKey: true, shiftKey: true });
    expect(fired).not.toHaveBeenCalled();
    press({ code: 'KeyI' });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('drops the three-modifier import chord under the accessibility collection', () => {
    chooseScheme('accessibility');
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="files.import" onFire={fired} />
      </>,
    );
    press({ code: 'KeyS', ctrlKey: true, shiftKey: true, altKey: true });
    expect(fired).not.toHaveBeenCalled();
    press({ code: 'KeyS', ctrlKey: true });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('keeps search out of a field only where the chord is a character', () => {
    chooseScheme('vim-inspired');
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.search" onFire={fired} />
      </>,
    );
    const input = document.createElement('input');
    document.body.append(input);

    // `/` is a character the operator may be typing into a path.
    press({ code: 'Slash' }, input);
    expect(fired).not.toHaveBeenCalled();
    press({ code: 'Slash' });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('prints the active collection’s chords in the list the operator learns from', () => {
    chooseScheme('accessibility');
    render(<KeybindList />);
    expect(screen.getByText('F1')).toBeDefined();
    expect(screen.getByText('Ctrl + S')).toBeDefined();
    expect(screen.queryByText('Ctrl + Shift + Alt + S')).toBeNull();
  });

  it('prints the sequence, not a combination, for a prefixed chord', () => {
    chooseScheme('vim-inspired');
    render(<KeybindList />);
    expect(screen.getByText('G → 2')).toBeDefined();
    expect(screen.queryByText('2')).toBeNull();
  });
});
