// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalTabs } from './TerminalTabs.js';
import type { TerminalTab } from './TerminalTabs.js';

/*
 * Base UI owns the tab roving focus, the panel mounting and the indicator
 * geometry. What `TerminalTabs` owns is the projection of a `tabs` array onto
 * that machinery -- a tab and a panel per entry, the list label, the indicator
 * nobody asked for -- and the narrowing of Base UI's `onValueChange` to the
 * value alone. Those are what is asserted here.
 *
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events at
 * it, and they are already dependencies of the package.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelValue = 'brief' | 'materials' | 'comms';

const tabs: ReadonlyArray<TerminalTab<PanelValue>> = [
  { value: 'brief', label: 'Бриф', content: <p data-panel="brief">Задание на смену</p> },
  { value: 'materials', label: 'Материалы', content: <p data-panel="materials">Опись</p> },
  { value: 'comms', label: 'Связь', content: <p data-panel="comms">Каналы</p>, disabled: true },
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

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const tabButtons = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.terminal-tabs__tab'));

const at = (container: HTMLElement, index: number): HTMLElement => {
  const element = tabButtons(container)[index];
  if (element === undefined) throw new Error(`no tab at ${String(index)}`);
  return element;
};

const list = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.terminal-tabs__list');
  if (element === null) throw new Error('tab list not rendered');
  return element;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalTabs', () => {
  it('renders a labelled tab per entry, an indicator, and only the selected panel', () => {
    const container = mount(
      <TerminalTabs
        value="materials"
        tabs={tabs}
        onValueChange={vi.fn()}
        label="Разделы смены"
        className="hq-shift-tabs"
      />,
    );

    expect(tabButtons(container).map((tab) => tab.textContent)).toEqual([
      'Бриф',
      'Материалы',
      'Связь',
    ]);
    expect(tabButtons(container).map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(list(container).getAttribute('aria-label')).toBe('Разделы смены');
    // The indicator is the wrapper's own addition: no consumer prop asks for it.
    expect(container.querySelectorAll('.terminal-tabs__indicator')).toHaveLength(1);
    expect(container.querySelector('.terminal-tabs')?.getAttribute('class')).toBe(
      'terminal-tabs hq-shift-tabs',
    );

    // A panel per entry is declared, but only the selected one is mounted, so
    // an unselected panel's content is absent rather than merely hidden.
    const panels = container.querySelectorAll('.terminal-tabs__panel');
    expect(panels).toHaveLength(1);
    expect(panels[0]?.textContent).toBe('Опись');
    expect(container.querySelector('[data-panel="brief"]')).toBeNull();
  });

  it('reports the clicked tab as the bare value and stays on the value it was given', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalTabs
        value="brief"
        tabs={tabs}
        onValueChange={onValueChange}
        label="Разделы смены"
      />,
    );

    click(at(container, 1));
    // Base UI hands the callback event details as a second argument; the
    // wrapper's signature is `(value) => void`, so the consumer sees the value
    // alone and nothing of the library's event shape.
    expect(onValueChange.mock.calls).toEqual([['materials']]);
    // The wrapper drives Base UI with `value`, not `defaultValue`: the owner
    // decides what is selected, so the click alone moves nothing.
    expect(at(container, 0).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.terminal-tabs__panel')?.textContent).toBe('Задание на смену');
  });

  it('never reports a disabled tab', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <TerminalTabs
        value="brief"
        tabs={tabs}
        onValueChange={onValueChange}
        label="Разделы смены"
      />,
    );

    expect(at(container, 2).getAttribute('aria-disabled')).toBe('true');
    expect(at(container, 2).hasAttribute('data-disabled')).toBe(true);
    expect(at(container, 1).getAttribute('aria-disabled')).toBe('false');
    click(at(container, 2));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('forwards a vertical orientation to the tab list', () => {
    const vertical = mount(
      <TerminalTabs
        value="brief"
        tabs={tabs}
        onValueChange={vi.fn()}
        label="Разделы смены"
        orientation="vertical"
      />,
    );
    expect(list(vertical).getAttribute('aria-orientation')).toBe('vertical');

    // Base UI marks only a vertical list, so the horizontal default is visible
    // here as the absence of the attribute rather than a value of its own.
    const horizontal = mount(
      <TerminalTabs value="brief" tabs={tabs} onValueChange={vi.fn()} label="Разделы смены" />,
    );
    expect(list(horizontal).hasAttribute('aria-orientation')).toBe(false);
    expect(vertical.querySelector('.terminal-tabs')?.getAttribute('data-orientation')).toBe(
      'vertical',
    );
  });
});
