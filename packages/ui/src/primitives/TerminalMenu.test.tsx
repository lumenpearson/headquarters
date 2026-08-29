// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TerminalMenu } from './TerminalMenu.js';
import type { TerminalMenuItem } from './TerminalMenu.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI opens, positions and closes the menu; none of that is asserted here.
 * What is this wrapper's own is the mapping from a flat `TerminalMenuItem[]`
 * onto menu entries -- the tone default, the optional shortcut, the per-item
 * disabled flag and the select callback -- plus the side/align defaults and
 * the decision to render the consumer's trigger element rather than wrap it.
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

/** Base UI positions with floating-ui, which resolves on a microtask. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function openWith(trigger: HTMLElement): void {
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const triggerOf = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector('button');
  if (element === null) throw new Error('trigger not rendered');
  return element;
};

const popup = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[role="menu"]');
  if (element === null) throw new Error('menu popup not open');
  return element;
};

const positioner = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.terminal-menu__positioner');
  if (element === null) throw new Error('positioner not rendered');
  return element;
};

const entries = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

beforeAll(() => {
  // floating-ui tracks the anchor with a ResizeObserver; jsdom performs no
  // layout and therefore ships none.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalMenu', () => {
  it('renders the trigger element it was handed and wires the menu onto it', async () => {
    const container = mount(
      <TerminalMenu
        trigger={
          <button type="button" className="ops-topbar__commands" data-owner="shell">
            КОМАНДЫ
          </button>
        }
        items={[{ id: 'a', label: 'Первый', onSelect: vi.fn() }]}
        label="Команды штаба"
      />,
    );
    const trigger = triggerOf(container);
    // `render={trigger}` merges rather than wraps: the consumer's own class and
    // data attribute survive, and no extra element is introduced around them.
    expect(trigger.className).toBe('ops-topbar__commands');
    expect(trigger.getAttribute('data-owner')).toBe('shell');
    expect(trigger.parentElement).toBe(container);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    openWith(trigger);
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(popup().id);
  });

  it('maps each item onto an entry: default tone, optional shortcut, disabled state', async () => {
    const items: readonly TerminalMenuItem[] = [
      { id: 'plain', label: 'Первый', onSelect: vi.fn() },
      { id: 'shortcut', label: 'Второй', shortcut: 'Ctrl+B', tone: 'primary', onSelect: vi.fn() },
      { id: 'off', label: 'Третий', tone: 'critical', disabled: true, onSelect: vi.fn() },
    ];
    const container = mount(
      <TerminalMenu
        trigger={<button type="button">Открыть</button>}
        items={items}
        label="Команды штаба"
        className="ops-menu"
      />,
    );
    openWith(triggerOf(container));
    await settle();

    expect(popup().getAttribute('aria-label')).toBe('Команды штаба');
    // The consumer's class is appended after the primitive's own semantic
    // class and the utility classes primitives.css still governs today, not
    // replacing either.
    const popupClass = popup().className;
    expect(popupClass.startsWith('terminal-menu ')).toBe(true);
    expect(popupClass.endsWith(' ops-menu')).toBe(true);
    expect(popup().closest('.terminal-menu__positioner')).toBe(positioner());

    const rendered = entries();
    expect(rendered.map((entry) => entry.textContent)).toEqual([
      'Первый',
      'ВторойCtrl+B',
      'Третий',
    ]);
    expect(rendered.every((entry) => entry.className.startsWith('terminal-menu__item'))).toBe(true);
    // An item that names no tone still carries one, so the stylesheet never has
    // to describe an entry without `data-tone`.
    expect(rendered.map((entry) => entry.getAttribute('data-tone'))).toEqual([
      'neutral',
      'primary',
      'critical',
    ]);
    expect(rendered.map((entry) => entry.querySelector('kbd')?.textContent ?? null)).toEqual([
      null,
      'Ctrl+B',
      null,
    ]);
    expect(rendered.map((entry) => entry.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
      'true',
    ]);
  });

  it('calls the selected item and only that item, and never a disabled one', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const blocked = vi.fn();
    const container = mount(
      <TerminalMenu
        trigger={<button type="button">Открыть</button>}
        items={[
          { id: 'a', label: 'Первый', onSelect: first },
          { id: 'b', label: 'Второй', onSelect: second },
          { id: 'c', label: 'Третий', disabled: true, onSelect: blocked },
        ]}
        label="Команды штаба"
      />,
    );
    openWith(triggerOf(container));
    await settle();

    const [, chosen, unavailable] = entries();
    if (chosen === undefined || unavailable === undefined) throw new Error('entries missing');
    act(() => {
      unavailable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(blocked).not.toHaveBeenCalled();

    act(() => {
      chosen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
  });

  it('defaults the popup below the trigger and aligned to its start, and forwards what it is given', async () => {
    const items: readonly TerminalMenuItem[] = [{ id: 'a', label: 'Первый', onSelect: vi.fn() }];
    const byDefault = mount(
      <TerminalMenu
        trigger={<button type="button">Открыть</button>}
        items={items}
        label="Команды штаба"
      />,
    );
    openWith(triggerOf(byDefault));
    await settle();
    expect(positioner().getAttribute('data-side')).toBe('bottom');
    expect(positioner().getAttribute('data-align')).toBe('start');

    for (const entry of mounted.splice(0)) {
      act(() => entry.root.unmount());
      entry.container.remove();
    }

    const placed = mount(
      <TerminalMenu
        trigger={<button type="button">Открыть</button>}
        items={items}
        label="Команды штаба"
        side="right"
        align="end"
      />,
    );
    openWith(triggerOf(placed));
    await settle();
    expect(positioner().getAttribute('data-side')).toBe('right');
    expect(positioner().getAttribute('data-align')).toBe('end');
  });
});
