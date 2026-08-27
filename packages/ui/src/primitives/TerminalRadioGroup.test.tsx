// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalRadioGroup } from './TerminalRadioGroup.js';
import type { TerminalRadioOption } from './TerminalRadioGroup.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns radio selection, roving focus and the ARIA state. What is under
 * test is the wrapper's own layer: the row it builds per option (native button
 * plus visible caption), the class list it composes, both labels mapped onto
 * accessible names, the two levels of `disabled`, and the change callback
 * narrowed to a single value.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mode = 'day' | 'night' | 'ir';

const options: ReadonlyArray<TerminalRadioOption<Mode>> = [
  { value: 'day', label: 'День' },
  { value: 'night', label: 'Ночь' },
  { value: 'ir', label: 'ИК' },
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

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const group = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.terminal-radio-group');
  if (element === null) throw new Error('radio group not rendered');
  return element;
};

const rows = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.terminal-radio-option'));

const controls = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.terminal-radio'));

const controlAt = (container: HTMLElement, index: number): HTMLButtonElement => {
  const element = controls(container)[index];
  if (element === undefined) throw new Error(`no radio at index ${index}`);
  return element;
};

function click(target: HTMLElement): void {
  act(() => target.click());
}

describe('TerminalRadioGroup', () => {
  it('builds one row per option, in order, pairing a native button with a visible caption', () => {
    const container = mount(
      <TerminalRadioGroup
        value="day"
        options={options}
        onValueChange={vi.fn()}
        label="Режим карты"
        className="settings-row__control"
      />,
    );
    expect([...group(container).classList]).toEqual([
      'terminal-radio-group',
      'settings-row__control',
    ]);
    expect(group(container).getAttribute('role')).toBe('radiogroup');
    expect(group(container).getAttribute('aria-label')).toBe('Режим карты');
    // `disabled` defaults to false, so the group is not announced as disabled.
    expect(group(container).getAttribute('aria-disabled')).toBeNull();

    const rendered = rows(container);
    expect(rendered).toHaveLength(3);
    expect(rendered.map((row) => row.querySelector(':scope > span')?.textContent)).toEqual([
      'День',
      'Ночь',
      'ИК',
    ]);
    for (const [index, row] of rendered.entries()) {
      const button = row.querySelector<HTMLButtonElement>('.terminal-radio');
      // Base UI renders a <span> unless told otherwise; this wrapper always asks
      // for a real button, and `type="button"` keeps it out of form submission.
      expect(button?.tagName).toBe('BUTTON');
      expect(button?.type).toBe('button');
      expect(button?.getAttribute('aria-label')).toBe(options[index]?.label);
    }
  });

  it('checks only the option whose value matches, and moves the tick when the value changes', () => {
    const container = mount(
      <TerminalRadioGroup
        value="night"
        options={options}
        onValueChange={vi.fn()}
        label="Режим карты"
      />,
    );
    expect(controls(container).map((button) => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    const indicators = container.querySelectorAll('.terminal-radio__indicator');
    expect(indicators).toHaveLength(1);
    expect(rows(container)[1]?.contains(indicators[0] ?? null)).toBe(true);

    const other = mount(
      <TerminalRadioGroup
        value="ir"
        options={options}
        onValueChange={vi.fn()}
        label="Режим карты"
      />,
    );
    expect(controls(other).map((button) => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
  });

  it("reports the clicked option's value as the single argument of onValueChange", () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalRadioGroup
        value="day"
        options={options}
        onValueChange={onValueChange}
        label="Режим карты"
      />,
    );
    click(controlAt(container, 2));
    // Exactly one argument: Base UI also passes event details, which the
    // wrapper drops so consumers can hand it a plain value setter.
    expect(onValueChange.mock.calls).toEqual([['ir']]);
  });

  it('disables a single option without touching its neighbours', () => {
    const onValueChange = vi.fn();
    const withLockedOption: ReadonlyArray<TerminalRadioOption<Mode>> = [
      { value: 'day', label: 'День' },
      { value: 'night', label: 'Ночь', disabled: true },
      { value: 'ir', label: 'ИК' },
    ];
    const container = mount(
      <TerminalRadioGroup
        value="day"
        options={withLockedOption}
        onValueChange={onValueChange}
        label="Режим карты"
      />,
    );
    expect(controls(container).map((button) => button.disabled)).toEqual([false, true, false]);
    click(controlAt(container, 1));
    expect(onValueChange).not.toHaveBeenCalled();
    click(controlAt(container, 2));
    expect(onValueChange.mock.calls).toEqual([['ir']]);
  });

  it('disables every option when the group is disabled', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalRadioGroup
        value="day"
        options={options}
        onValueChange={onValueChange}
        label="Режим карты"
        disabled
      />,
    );
    expect(group(container).getAttribute('aria-disabled')).toBe('true');
    expect(controls(container).map((button) => button.disabled)).toEqual([true, true, true]);
    click(controlAt(container, 1));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
