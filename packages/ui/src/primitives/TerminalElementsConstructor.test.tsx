// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalElementsConstructor } from './TerminalElementsConstructor.js';
import type { TerminalElementsConstructorOption } from './TerminalElementsConstructor.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: ReadonlyArray<TerminalElementsConstructorOption> = [
  { value: 'title', label: 'ЗАГОЛОВОК ОКНА' },
  { value: 'information', label: 'ИНФОРМАЦИОННЫЙ СЛОТ' },
  { value: 'close', label: 'ЗАКРЫТЬ' },
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

const rows = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.terminal-elements-constructor__row'));

const rowLabels = (container: HTMLElement): (string | undefined)[] =>
  rows(container).map(
    (row) => row.querySelector('.terminal-elements-constructor__label')?.textContent ?? undefined,
  );

const addButtons = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.terminal-elements-constructor__add'));

function click(target: HTMLElement | null | undefined): void {
  if (target === null || target === undefined) throw new Error('no target to click');
  act(() => target.click());
}

describe('TerminalElementsConstructor', () => {
  it('draws chosen members as ordered rows and the rest as add buttons', () => {
    const container = mount(
      <TerminalElementsConstructor
        value={['close', 'title']}
        options={options}
        onValueChange={vi.fn()}
        label="Элементы верхней панели"
      />,
    );
    expect(rowLabels(container)).toEqual(['ЗАКРЫТЬ', 'ЗАГОЛОВОК ОКНА']);
    expect(addButtons(container).map((button) => button.textContent)).toEqual([
      '+ ИНФОРМАЦИОННЫЙ СЛОТ',
    ]);
  });

  it('appends a member when its add button is pressed', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalElementsConstructor
        value={['title']}
        options={options}
        onValueChange={onValueChange}
        label="Элементы верхней панели"
      />,
    );
    click(addButtons(container)[0]);
    expect(onValueChange.mock.calls).toEqual([[['title', 'information']]]);
  });

  it('removes a member when its remove button is pressed, keeping the rest in order', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalElementsConstructor
        value={['title', 'information', 'close']}
        options={options}
        onValueChange={onValueChange}
        label="Элементы верхней панели"
      />,
    );
    click(rows(container)[1]?.querySelector('.terminal-elements-constructor__remove'));
    expect(onValueChange.mock.calls).toEqual([[['title', 'close']]]);
  });

  it('reorders a member with the up and down controls, clamped at the ends', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalElementsConstructor
        value={['title', 'information', 'close']}
        options={options}
        onValueChange={onValueChange}
        label="Элементы верхней панели"
      />,
    );
    click(
      rows(container)[1]?.querySelector('.terminal-elements-constructor__move[aria-label*="выше"]'),
    );
    expect(onValueChange.mock.calls.at(-1)).toEqual([['information', 'title', 'close']]);

    // The first row's own "up" control is disabled and does nothing.
    const firstUp = rows(container)[0]?.querySelector<HTMLButtonElement>(
      '.terminal-elements-constructor__move[aria-label*="выше"]',
    );
    expect(firstUp?.disabled).toBe(true);
  });
});
