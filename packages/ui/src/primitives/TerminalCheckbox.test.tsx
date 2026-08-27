// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalCheckbox } from './TerminalCheckbox.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the checkbox state machine, the hidden input and the ARIA state,
 * and none of that is retested here. What is under test is the wrapper's own
 * layer: the native <button> it renders in place of Base UI's default <span>,
 * the class list it composes, `label` mapped onto the accessible name, the two
 * indicator glyphs, and the change callback narrowed to a single boolean.
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

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const control = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector<HTMLButtonElement>('.terminal-checkbox');
  if (element === null) throw new Error('checkbox not rendered');
  return element;
};

const indicator = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('.terminal-checkbox__indicator');

function click(target: HTMLElement): void {
  act(() => target.click());
}

describe('TerminalCheckbox', () => {
  it('renders a native non-submitting button carrying the label and the composed class list', () => {
    const container = mount(
      <TerminalCheckbox checked={false} onCheckedChange={vi.fn()} label="Показывать сетку" />,
    );
    const button = control(container);
    // Base UI renders a <span> unless told otherwise; this wrapper always asks
    // for a real button, and `type="button"` keeps it out of form submission.
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Показывать сетку');
    expect(button.disabled).toBe(false);
    expect([...button.classList]).toEqual(['terminal-checkbox']);
    // Nothing is ticked, so the indicator is not in the tree at all.
    expect(indicator(container)).toBeNull();

    const themed = mount(
      <TerminalCheckbox
        checked={false}
        onCheckedChange={vi.fn()}
        label="Показывать сетку"
        className="settings-row__control"
      />,
    );
    expect([...control(themed).classList]).toEqual(['terminal-checkbox', 'settings-row__control']);
  });

  it('draws the tick while checked and the dash while indeterminate, whatever `checked` says', () => {
    const ticked = mount(
      <TerminalCheckbox checked onCheckedChange={vi.fn()} label="Показывать сетку" />,
    );
    expect(indicator(ticked)?.textContent).toBe('[×]');

    // The dash wins over the tick, and it is drawn even though `checked` is false.
    const mixed = mount(
      <TerminalCheckbox
        checked={false}
        onCheckedChange={vi.fn()}
        label="Показывать сетку"
        indeterminate
      />,
    );
    expect(indicator(mixed)?.textContent).toBe('[−]');
    expect(control(mixed).getAttribute('aria-checked')).toBe('mixed');
  });

  it('reports the next checked state as the single argument of onCheckedChange', () => {
    const onCheckedChange = vi.fn();
    const off = mount(
      <TerminalCheckbox checked={false} onCheckedChange={onCheckedChange} label="Сетка" />,
    );
    click(control(off));
    // Exactly one argument: Base UI also passes event details, which the
    // wrapper drops so consumers can hand it a plain boolean setter.
    expect(onCheckedChange.mock.calls).toEqual([[true]]);

    onCheckedChange.mockClear();
    const on = mount(<TerminalCheckbox checked onCheckedChange={onCheckedChange} label="Сетка" />);
    click(control(on));
    expect(onCheckedChange.mock.calls).toEqual([[false]]);
  });

  it('stays silent and natively disabled when disabled', () => {
    const onCheckedChange = vi.fn();
    const container = mount(
      <TerminalCheckbox checked={false} onCheckedChange={onCheckedChange} label="Сетка" disabled />,
    );
    expect(control(container).disabled).toBe(true);
    click(control(container));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
