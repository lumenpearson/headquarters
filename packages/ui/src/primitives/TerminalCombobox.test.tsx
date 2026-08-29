// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalCombobox } from './TerminalCombobox.js';
import type { TerminalComboboxOption } from './TerminalCombobox.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the popup, the query matching and the highlight; none of that is
 * asserted here. What this wrapper adds is `itemToStringLabel` -- the only
 * reason the input ever shows a human label instead of the raw value -- the two
 * aria labels it composes, the class and placeholder defaults, and the
 * option -> item mapping that carries `value` and `disabled` across.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: ReadonlyArray<TerminalComboboxOption<string>> = [
  { value: 'alpha', label: 'Альфа' },
  { value: 'beta', label: 'Бета' },
  { value: 'gamma', label: 'Гамма', disabled: true },
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

const input = (container: HTMLElement): HTMLInputElement =>
  mustFind<HTMLInputElement>(container, 'input.terminal-combobox__input');

const trigger = (container: HTMLElement): HTMLButtonElement =>
  mustFind<HTMLButtonElement>(container, 'button.terminal-combobox__trigger');

/** The popup is portalled to `document.body`, so items are looked up from the document. */
const items = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.terminal-combobox__item'));

function open(container: HTMLElement): HTMLElement[] {
  act(() => trigger(container).click());
  return items();
}

/** React tracks the input's own value, so the native setter has to be used to fake typing. */
function typeQuery(container: HTMLElement, text: string): void {
  const field = input(container);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(
    field,
  );
  if (setValue === undefined) throw new Error('no native value setter');
  act(() => {
    setValue(text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalCombobox', () => {
  it('labels the input and the trigger, and defaults the placeholder', () => {
    const container = mount(
      <TerminalCombobox
        value={null}
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
        className="panel-combobox"
      />,
    );
    expect(mustFind(container, '.terminal-combobox').className).toBe(
      'terminal-combobox grid min-w-0 grid-cols-[minmax(0,1fr)_32px] border border-hq-line-1 bg-hq-bg-0 focus-within:border-hq-line-focus data-[popup-open]:border-hq-line-focus panel-combobox',
    );
    expect(input(container).getAttribute('aria-label')).toBe('Канал связи');
    expect(input(container).getAttribute('placeholder')).toBe('[SEARCH / SELECT]');
    // The trigger's label is composed from the field label, not repeated by the consumer.
    expect(trigger(container).getAttribute('aria-label')).toBe('Открыть список: Канал связи');
    expect(trigger(container).textContent).toBe('[⌄]');
  });

  it('displays the option label for the current value and the raw value when there is no option', () => {
    const known = mount(
      <TerminalCombobox
        value="beta"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    // Without the wrapper's `itemToStringLabel` this would read "beta".
    expect(input(known).value).toBe('Бета');

    const unknown = mount(
      <TerminalCombobox
        value="delta"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    expect(input(unknown).value).toBe('delta');
  });

  it('reports the chosen option value, and nothing for a disabled option', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalCombobox
        value={null}
        options={options}
        onValueChange={onValueChange}
        label="Канал связи"
      />,
    );
    const rendered = open(container);
    expect(rendered.map((item) => item.textContent)).toEqual(['Альфа', 'Бета', 'Гамма']);
    const disabled = rendered[2];
    const enabled = rendered[1];
    if (disabled === undefined || enabled === undefined) throw new Error('items missing');

    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    act(() => disabled.click());
    expect(onValueChange).not.toHaveBeenCalled();

    act(() => enabled.click());
    expect(onValueChange.mock.calls).toEqual([['beta']]);
  });

  it('keeps item text as the last child so the CSS grid pin lands it in the text column', () => {
    /*
     * `.terminal-combobox__item > :last-child { grid-column: 2 }` (primitives.css)
     * relies on the label `<span>` always being the last child of an item,
     * whether or not `Combobox.ItemIndicator` renders ahead of it. jsdom
     * does not compute grid placement, so this asserts the structural
     * contract the CSS pin depends on rather than the resulting layout.
     */
    const container = mount(
      <TerminalCombobox
        value="beta"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    const rendered = open(container);
    rendered.forEach((item, index) => {
      const option = options[index];
      if (option === undefined) throw new Error('option missing');
      // Every item's last child is its label span, matched by option order, never the indicator.
      expect(item.lastElementChild?.textContent).toBe(option.label);
      expect(item.lastElementChild?.classList.contains('terminal-combobox__indicator')).toBe(false);
    });

    const selected = rendered[1];
    if (selected === undefined) throw new Error('items missing');
    // The selected item has two children; the indicator, when present, is first, never last.
    expect(selected.children).toHaveLength(2);
    expect(selected.firstElementChild?.classList.contains('terminal-combobox__indicator')).toBe(
      true,
    );
  });

  it('shows the empty label the wrapper defaults, and the one the consumer overrides it with', () => {
    const standard = mount(
      <TerminalCombobox
        value={null}
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
      />,
    );
    open(standard);
    typeQuery(standard, 'щщщ');
    expect(mustFind(document, '.terminal-combobox__empty').textContent).toBe('[ НЕТ СОВПАДЕНИЙ ]');

    // Unmount the first popup so the document holds exactly one empty node.
    for (const entry of mounted.splice(0)) {
      act(() => entry.root.unmount());
      entry.container.remove();
    }

    const custom = mount(
      <TerminalCombobox
        value={null}
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
        emptyLabel="[ ПУСТО ]"
      />,
    );
    open(custom);
    typeQuery(custom, 'щщщ');
    expect(mustFind(document, '.terminal-combobox__empty').textContent).toBe('[ ПУСТО ]');
  });

  it('disables the input and the trigger together', () => {
    const container = mount(
      <TerminalCombobox
        value="alpha"
        options={options}
        onValueChange={vi.fn()}
        label="Канал связи"
        disabled
      />,
    );
    expect(input(container).disabled).toBe(true);
    expect(trigger(container).disabled).toBe(true);
    expect(open(container)).toHaveLength(0);
  });
});
