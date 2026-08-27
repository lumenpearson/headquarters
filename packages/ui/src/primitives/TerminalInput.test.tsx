// @vitest-environment jsdom
import { act, createRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalInput } from './TerminalInput.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * TerminalInput is a thin wrapper -- coverage here is largely a change
 * detector. Everything an `<input>` does is Base UI's `Input`; the wrapper's
 * own logic is exactly two things: the fixed class prefix that binds the
 * control to `hq-input`/`terminal-input` in the stylesheet, and the ref
 * forwarding that lets a caller reach the element. Both are asserted below,
 * along with the prop spread that keeps the rest of Base UI's surface usable.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLDivElement }[] = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

const input = (container: HTMLElement): HTMLInputElement => {
  const element = container.querySelector('input');
  if (element === null) throw new Error('input not rendered');
  return element;
};

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

/** React listens for `input`, not `change`, and reads the value off the element. */
function type(element: HTMLInputElement, value: string): void {
  if (nativeValueSetter === undefined) throw new Error('no native value setter');
  nativeValueSetter.call(element, value);
  act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalInput', () => {
  it('always carries both stylesheet classes and appends the caller class after them', () => {
    const bare = mount(<TerminalInput />);
    expect(input(bare).getAttribute('class')).toBe('hq-input terminal-input');

    const dressed = mount(<TerminalInput className="settings-editor__value" />);
    // The caller adds to the base classes; it cannot displace them.
    expect(dressed.querySelector('input')?.getAttribute('class')).toBe(
      'hq-input terminal-input settings-editor__value',
    );
  });

  it('forwards the ref to the rendered input element', () => {
    const reference = createRef<HTMLElement>();
    const container = mount(<TerminalInput ref={reference} />);
    expect(reference.current).toBe(input(container));
    expect(reference.current).toBeInstanceOf(HTMLInputElement);
  });

  it('passes the remaining props through to Base UI, callbacks included', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalInput
        id="callsign"
        placeholder="позывной"
        maxLength={12}
        defaultValue="ЭХО"
        onValueChange={onValueChange}
      />,
    );
    const element = input(container);
    expect(element.id).toBe('callsign');
    expect(element.placeholder).toBe('позывной');
    expect(element.maxLength).toBe(12);
    expect(element.value).toBe('ЭХО');

    type(element, 'ФОКСТРОТ');
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls[0]?.[0]).toBe('ФОКСТРОТ');
  });
});
