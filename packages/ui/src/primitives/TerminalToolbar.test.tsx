// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalToolbar } from './TerminalToolbar.js';
import type { TerminalToolbarAction } from './TerminalToolbar.js';

/*
 * Base UI owns the toolbar's roving focus and its disabled-button semantics.
 * What `TerminalToolbar` owns is the projection of an `actions` array onto that
 * toolbar: one button per action, the tone default, the optional shortcut, and
 * the `onPress` -> `onClick` wiring. Those are what is asserted here.
 *
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events at
 * it, and they are already dependencies of the package.
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

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const buttons = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.terminal-toolbar__button'));

const toolbar = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.terminal-toolbar');
  if (element === null) throw new Error('toolbar not rendered');
  return element;
};

const at = (container: HTMLElement, index: number): HTMLElement => {
  const element = buttons(container)[index];
  if (element === undefined) throw new Error(`no button at ${String(index)}`);
  return element;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalToolbar', () => {
  it('renders one button per action in order, defaulting the tone and omitting an absent shortcut', () => {
    const actions: ReadonlyArray<TerminalToolbarAction> = [
      { id: 'take', label: 'Дубль', shortcut: 'F5', onPress: vi.fn() },
      { id: 'cut', label: 'Стоп', tone: 'critical', onPress: vi.fn() },
      { id: 'mark', label: 'Метка', tone: 'primary', shortcut: 'Ctrl+M', onPress: vi.fn() },
    ];
    const container = mount(<TerminalToolbar actions={actions} label="Управление съёмкой" />);

    expect(buttons(container).map((button) => button.textContent)).toEqual([
      'ДубльF5',
      'Стоп',
      'МеткаCtrl+M',
    ]);
    // The tone is a data attribute rather than a class so the stylesheet can key
    // off it; an action that names no tone must still carry the neutral default.
    expect(buttons(container).map((button) => button.getAttribute('data-tone'))).toEqual([
      'neutral',
      'critical',
      'primary',
    ]);
    // A shortcut is rendered as `kbd`, and only when the action has one.
    expect(at(container, 0).querySelector('kbd')?.textContent).toBe('F5');
    expect(at(container, 1).querySelector('kbd')).toBeNull();
  });

  it('presses only the action that was clicked', () => {
    const take = vi.fn();
    const cut = vi.fn();
    const actions: ReadonlyArray<TerminalToolbarAction> = [
      { id: 'take', label: 'Дубль', onPress: take },
      { id: 'cut', label: 'Стоп', onPress: cut },
    ];
    const container = mount(<TerminalToolbar actions={actions} label="Управление съёмкой" />);

    click(at(container, 1));
    expect(cut).toHaveBeenCalledTimes(1);
    expect(take).not.toHaveBeenCalled();

    click(at(container, 0));
    expect(take).toHaveBeenCalledTimes(1);
    expect(cut).toHaveBeenCalledTimes(1);
  });

  it('marks a disabled action as such and never presses it', () => {
    const onPress = vi.fn();
    const actions: ReadonlyArray<TerminalToolbarAction> = [
      { id: 'wrap', label: 'Отбой', disabled: true, onPress },
      { id: 'take', label: 'Дубль', onPress: vi.fn() },
    ];
    const container = mount(<TerminalToolbar actions={actions} label="Управление съёмкой" />);

    expect(at(container, 0).getAttribute('aria-disabled')).toBe('true');
    expect(at(container, 0).hasAttribute('data-disabled')).toBe(true);
    expect(at(container, 1).getAttribute('aria-disabled')).toBe('false');
    click(at(container, 0));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('labels the toolbar, keeps its own class first and forwards the orientation', () => {
    const actions: ReadonlyArray<TerminalToolbarAction> = [
      { id: 'take', label: 'Дубль', onPress: vi.fn() },
    ];
    const container = mount(
      <TerminalToolbar
        actions={actions}
        label="Управление съёмкой"
        className="hq-shot-toolbar"
        orientation="vertical"
      />,
    );
    expect(toolbar(container).getAttribute('aria-label')).toBe('Управление съёмкой');
    const toolbarClass = toolbar(container).getAttribute('class') ?? '';
    expect(toolbarClass.startsWith('terminal-toolbar')).toBe(true);
    expect(toolbarClass.endsWith('hq-shot-toolbar')).toBe(true);
    expect(toolbar(container).getAttribute('aria-orientation')).toBe('vertical');

    // Only the vertical case above can fail on the default alone: Base UI's own
    // toolbar default is horizontal too, so this pins the wrapper's contract
    // rather than the library's.
    const horizontal = mount(<TerminalToolbar actions={actions} label="Управление съёмкой" />);
    expect(toolbar(horizontal).getAttribute('aria-orientation')).toBe('horizontal');
  });
});
