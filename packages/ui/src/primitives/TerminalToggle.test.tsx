// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalToggle } from './TerminalToggle.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI's `Toggle` is not under test. The wrapper narrows it to five props,
 * and that narrowing is the behaviour: `pressed` is wired as the controlled
 * value rather than the initial one, `label` serves as both the name and the
 * content, and `onPressedChange` is re-signed to a single boolean.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLDivElement }[] = [];

function mount(element: ReactElement): {
  container: HTMLDivElement;
  render: (next: ReactElement) => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return { container, render: (next) => act(() => root.render(next)) };
}

const button = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector('button');
  if (element === null) throw new Error('no toggle rendered');
  return element;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalToggle', () => {
  it('uses the label as both the accessible name and the visible content, with the caller class last', () => {
    const rendered = button(
      mount(
        <TerminalToggle
          pressed={false}
          onPressedChange={vi.fn()}
          label="Сетка"
          className="hq-toolbar__toggle"
        />,
      ).container,
    );
    expect(rendered.getAttribute('aria-label')).toBe('Сетка');
    expect(rendered.textContent).toBe('Сетка');
    expect(rendered.className).toBe('terminal-toggle hq-toolbar__toggle');
    expect(rendered.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the next state as one boolean, dropping the event details Base UI passes', () => {
    const onPressedChange = vi.fn<(pressed: boolean) => void>();
    const rendered = button(
      mount(<TerminalToggle pressed={false} onPressedChange={onPressedChange} label="Звук" />)
        .container,
    );

    act(() => rendered.click());
    /*
     * Base UI calls `onPressedChange(next, details)`. The wrapper's own arrow is
     * what keeps the second argument out of the consumer's callback, so the call
     * is compared whole rather than by its first argument.
     */
    expect(onPressedChange.mock.calls).toEqual([[true]]);
  });

  it('is controlled: the pressed prop, not the click, decides what the DOM shows', () => {
    const onPressedChange = vi.fn<(pressed: boolean) => void>();
    const harness = mount(
      <TerminalToggle pressed={false} onPressedChange={onPressedChange} label="Разметка" />,
    );
    const rendered = button(harness.container);

    act(() => rendered.click());
    // The owner has not fed a new value back yet, so nothing may move on its own.
    expect(rendered.getAttribute('aria-pressed')).toBe('false');
    expect(rendered.hasAttribute('data-pressed')).toBe(false);

    harness.render(<TerminalToggle pressed onPressedChange={onPressedChange} label="Разметка" />);
    expect(rendered.getAttribute('aria-pressed')).toBe('true');
    expect(rendered.hasAttribute('data-pressed')).toBe(true);
  });

  it('is enabled unless disabled is asked for, and a disabled toggle reports nothing', () => {
    const onPressedChange = vi.fn<(pressed: boolean) => void>();
    const enabled = button(
      mount(<TerminalToggle pressed={false} onPressedChange={onPressedChange} label="Сетка" />)
        .container,
    );
    expect(enabled.disabled).toBe(false);

    const disabled = button(
      mount(
        <TerminalToggle pressed={false} onPressedChange={onPressedChange} label="Сетка" disabled />,
      ).container,
    );
    expect(disabled.disabled).toBe(true);
    act(() => disabled.click());
    expect(onPressedChange).not.toHaveBeenCalled();
  });
});
