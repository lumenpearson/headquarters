// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalColorPicker } from './TerminalColorPicker.js';
import type { TerminalColorPickerOption } from './TerminalColorPicker.js';

/*
 * Same seam as `TerminalRadioGroup.test.tsx`: Base UI owns radio selection,
 * roving focus and the ARIA state, so what is under test is the wrapper's own
 * layer -- one swatch per option, the swatch's own background carrying the
 * color rather than a token name, the class list, and the change callback
 * narrowed to a single value.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Accent = 'orange' | 'green' | 'cyan';

/*
 * jsdom normalizes an inline `background` to `rgb(...)` at read time, so the
 * fixtures are given in that form directly rather than asserting a hex string
 * against a browser normalization this suite does not control.
 */
const options: ReadonlyArray<TerminalColorPickerOption<Accent>> = [
  { value: 'orange', label: 'ОРАНЖЕВЫЙ', swatch: 'rgb(255, 61, 0)' },
  { value: 'green', label: 'ЗЕЛЁНЫЙ', swatch: 'rgb(83, 185, 121)' },
  { value: 'cyan', label: 'ГОЛУБОЙ', swatch: 'rgb(69, 185, 198)' },
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
  const element = container.querySelector<HTMLElement>('.terminal-color-picker');
  if (element === null) throw new Error('color picker not rendered');
  return element;
};

const swatches = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.terminal-color-swatch'));

function click(target: HTMLElement): void {
  act(() => target.click());
}

describe('TerminalColorPicker', () => {
  it('renders one swatch per option, each carrying its own color as a background', () => {
    const container = mount(
      <TerminalColorPicker
        value="orange"
        options={options}
        onValueChange={vi.fn()}
        label="Акцентный цвет"
      />,
    );
    expect(group(container).getAttribute('role')).toBe('radiogroup');
    expect(group(container).getAttribute('aria-label')).toBe('Акцентный цвет');

    const rendered = swatches(container);
    expect(rendered).toHaveLength(3);
    for (const [index, button] of rendered.entries()) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-label')).toBe(options[index]?.label);
      expect(button.style.background).toBe(options[index]?.swatch);
    }
  });

  it('checks only the swatch whose value matches', () => {
    const container = mount(
      <TerminalColorPicker
        value="green"
        options={options}
        onValueChange={vi.fn()}
        label="Акцентный цвет"
      />,
    );
    expect(swatches(container).map((button) => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it("reports the clicked swatch's value as the single argument of onValueChange", () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalColorPicker
        value="orange"
        options={options}
        onValueChange={onValueChange}
        label="Акцентный цвет"
      />,
    );
    const target = swatches(container)[2];
    if (target === undefined) throw new Error('no swatch at index 2');
    click(target);
    expect(onValueChange.mock.calls).toEqual([['cyan']]);
  });

  it('disables a single swatch without touching its neighbours', () => {
    const onValueChange = vi.fn();
    const withLockedOption: ReadonlyArray<TerminalColorPickerOption<Accent>> = [
      options[0]!,
      { ...options[1]!, disabled: true },
      options[2]!,
    ];
    const container = mount(
      <TerminalColorPicker
        value="orange"
        options={withLockedOption}
        onValueChange={onValueChange}
        label="Акцентный цвет"
      />,
    );
    expect(swatches(container).map((button) => button.disabled)).toEqual([false, true, false]);
    const locked = swatches(container)[1];
    if (locked === undefined) throw new Error('no swatch at index 1');
    click(locked);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
