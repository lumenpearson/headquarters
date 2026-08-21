// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeybindRuntime, subscribeKeybindFired, useKeybind } from './KeybindRuntime';

function Subscriber({ id, onFire }: { readonly id: string; readonly onFire: () => void }) {
  useKeybind(id, onFire);
  return null;
}

function press(init: KeyboardEventInit & { code: string }, target?: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(event);
  return event;
}

describe('KeybindRuntime', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('delivers a matched keybind to whoever owns it', () => {
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.fullscreen" onFire={fired} />
      </>,
    );
    press({ code: 'KeyF' });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('swallows the key only when a handler actually ran', () => {
    render(<KeybindRuntime />);
    // Declared but unowned on this screen: the browser keeps its default,
    // because the alternative is an application that eats keys it ignores.
    expect(press({ code: 'KeyF' }).defaultPrevented).toBe(false);
  });

  it('leaves Escape to the overlays that close on it', () => {
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.dismiss" onFire={fired} />
      </>,
    );
    const event = press({ code: 'Escape' });
    expect(fired).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not steal a character from a field being typed into', () => {
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="navigate.objects" onFire={fired} />
      </>,
    );
    const input = document.createElement('input');
    document.body.append(input);
    press({ code: 'Digit2' }, input);
    expect(fired).not.toHaveBeenCalled();
  });

  it('still reaches search from inside a field', () => {
    const fired = vi.fn();
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.search" onFire={fired} />
      </>,
    );
    const input = document.createElement('input');
    document.body.append(input);
    press({ code: 'KeyK', ctrlKey: true }, input);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('stops delivering once an owner unmounts', () => {
    const fired = vi.fn();
    const view = render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.fullscreen" onFire={fired} />
      </>,
    );
    view.rerender(<KeybindRuntime />);
    press({ code: 'KeyF' });
    expect(fired).not.toHaveBeenCalled();
  });

  it('announces what fired, so the list can highlight it', () => {
    const announced: string[] = [];
    const unsubscribe = subscribeKeybindFired((id) => announced.push(id));
    render(
      <>
        <KeybindRuntime />
        <Subscriber id="shell.fullscreen" onFire={() => undefined} />
      </>,
    );
    press({ code: 'KeyF' });
    unsubscribe();
    expect(announced).toEqual(['shell.fullscreen']);
  });

  it('announces nothing for a keybind that did nothing here', () => {
    // Highlighting a row whose action no screen provides would tell the
    // operator a key works when it does not.
    const announced: string[] = [];
    const unsubscribe = subscribeKeybindFired((id) => announced.push(id));
    render(<KeybindRuntime />);
    press({ code: 'KeyF' });
    unsubscribe();
    expect(announced).toEqual([]);
  });
});
