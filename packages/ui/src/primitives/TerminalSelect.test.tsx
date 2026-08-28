// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalSelect } from './TerminalSelect.js';
import type { TerminalSelectOption } from './TerminalSelect.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the listbox, the roving focus and the positioning, and none of
 * that is asserted here. What this wrapper adds is the label lookup behind
 * `Select.Value`, the `[SELECT]` placeholder fallback, the class and
 * `aria-label` it puts on the trigger, and the option -> item mapping that
 * carries `value` and `disabled` across.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: ReadonlyArray<TerminalSelectOption<string>> = [
  { value: 'alpha', label: 'Альфа' },
  { value: 'beta', label: 'Бета', disabled: true },
  { value: 'gamma', label: 'Гамма' },
];

const mounted: { root: Root; container: HTMLDivElement }[] = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

function mustFind<T extends Element>(scope: ParentNode, selector: string): T {
  const element = scope.querySelector<T>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const trigger = (container: HTMLElement): HTMLButtonElement =>
  mustFind<HTMLButtonElement>(container, 'button.terminal-select');

/** `Select.Value` renders unclassed; it is the trigger's first child, ahead of the icon. */
const selectedLabel = (container: HTMLElement): string | null =>
  trigger(container).firstElementChild?.textContent ?? null;

/** The popup is portalled to `document.body`, so items are looked up from the document. */
const items = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.terminal-select__item'));

function open(container: HTMLElement): HTMLElement[] {
  act(() => trigger(container).click());
  return items();
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalSelect', () => {
  it('labels the trigger and shows the selected option label beside the caret', () => {
    const container = mount(
      <TerminalSelect
        value="gamma"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
        className="panel-select"
      />,
    );
    expect(trigger(container).getAttribute('aria-label')).toBe('Канал связи');
    // `classNames` appends the consumer class rather than replacing the base one.
    expect(trigger(container).className).toBe('terminal-select panel-select');
    // The raw value never reaches the trigger: the option's label is looked up.
    expect(selectedLabel(container)).toBe('Гамма');
    expect(mustFind(container, '.terminal-select__icon').textContent).toBe('[⌄]');
  });

  it('falls back to the placeholder when the value matches no option', () => {
    const unknown = mount(
      <TerminalSelect
        value="delta"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    expect(selectedLabel(unknown)).toBe('[SELECT]');

    const custom = mount(
      <TerminalSelect
        value="delta"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
        placeholder="[НЕТ СИГНАЛА]"
      />,
    );
    expect(selectedLabel(custom)).toBe('[НЕТ СИГНАЛА]');
  });

  it('renders one item per option, marks the selected one and disables what the option disables', () => {
    const container = mount(
      <TerminalSelect
        value="alpha"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    const rendered = open(container);
    expect(rendered.map((item) => item.textContent)).toEqual(['[×]Альфа', 'Бета', 'Гамма']);

    const selected = rendered[0];
    const disabled = rendered[1];
    if (selected === undefined || disabled === undefined) throw new Error('items missing');
    // The indicator glyph is the wrapper's, and only the selected item carries it.
    expect(mustFind(selected, '.terminal-select__indicator').textContent).toBe('[×]');
    expect(selected.hasAttribute('data-selected')).toBe(true);
    expect(disabled.querySelector('.terminal-select__indicator')).toBeNull();
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps item text as the last child so the CSS grid pin lands it in the text column', () => {
    /*
     * `.terminal-select__item > :last-child { grid-column: 2 }` (primitives.css)
     * relies on `Select.ItemText` always being the last child of an item,
     * whether or not `Select.ItemIndicator` renders ahead of it. jsdom does
     * not compute grid placement, so this asserts the structural contract
     * the CSS pin depends on rather than the resulting layout.
     */
    const container = mount(
      <TerminalSelect
        value="alpha"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    const rendered = open(container);
    rendered.forEach((item, index) => {
      const option = options[index];
      if (option === undefined) throw new Error('option missing');
      // Every item's last child is its text, matched by option order, never the indicator.
      expect(item.lastElementChild?.textContent).toBe(option.label);
      expect(item.lastElementChild?.classList.contains('terminal-select__indicator')).toBe(false);
    });

    const selected = rendered[0];
    if (selected === undefined) throw new Error('items missing');
    // The selected item has two children; the indicator, when present, is first, never last.
    expect(selected.children).toHaveLength(2);
    expect(selected.firstElementChild?.classList.contains('terminal-select__indicator')).toBe(true);
  });

  it('reports the chosen option value once, and nothing for a disabled option', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalSelect
        value="alpha"
        options={options}
        onValueChange={onValueChange}
        label="Канал связи"
      />,
    );
    const rendered = open(container);
    const disabled = rendered[1];
    const enabled = rendered[2];
    if (disabled === undefined || enabled === undefined) throw new Error('items missing');

    act(() => disabled.click());
    expect(onValueChange).not.toHaveBeenCalled();

    act(() => enabled.click());
    expect(onValueChange.mock.calls).toEqual([['gamma']]);
  });

  it('refuses to open while disabled', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalSelect
        value="alpha"
        options={options}
        onValueChange={onValueChange}
        label="Канал связи"
        disabled
      />,
    );
    expect(trigger(container).disabled).toBe(true);
    expect(open(container)).toHaveLength(0);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
