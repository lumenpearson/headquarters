// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TerminalPointerMenu } from './TerminalPointerMenu.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the popup, its focus trap and the collision arithmetic; none of
 * that is asserted here. This wrapper's own are the virtual anchor built from
 * `x`/`y` (and rebuilt when they change), the narrowing of Base UI's open
 * callback down to a single boolean, and the same item mapping `TerminalMenu`
 * performs.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  readonly container: HTMLDivElement;
  readonly rerender: (next: ReactElement) => void;
}

const mounted: { root: Root; container: HTMLDivElement }[] = [];

function mount(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return {
    container,
    rerender: (next) => {
      act(() => root.render(next));
    },
  };
}

/** Base UI positions with floating-ui, which resolves on a microtask. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const popup = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[role="menu"]');
  if (element === null) throw new Error('menu popup not open');
  return element;
};

const entries = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

/**
 * Where floating-ui put the popup, read off the positioner's own translate.
 * jsdom measures every box as zero, so the absolute numbers carry no meaning --
 * only how they move with the anchor does.
 */
function translation(): { x: number; y: number } {
  const element = document.querySelector<HTMLElement>('.terminal-menu__positioner');
  if (element === null) throw new Error('positioner not rendered');
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(element.style.transform);
  if (match === null) throw new Error(`positioner was never placed: ${element.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

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

describe('TerminalPointerMenu', () => {
  it('stays out of the document until it is opened, then portals a labelled menu', async () => {
    const view = mount(
      <TerminalPointerMenu
        open={false}
        onOpenChange={vi.fn()}
        x={120}
        y={80}
        items={[{ id: 'a', label: 'Первый', onSelect: vi.fn() }]}
        label="Действия"
        className="ops-runtime-menu"
      />,
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();

    view.rerender(
      <TerminalPointerMenu
        open
        onOpenChange={vi.fn()}
        x={120}
        y={80}
        items={[{ id: 'a', label: 'Первый', onSelect: vi.fn() }]}
        label="Действия"
        className="ops-runtime-menu"
      />,
    );
    await settle();

    expect(popup().getAttribute('aria-label')).toBe('Действия');
    // Both the shared menu class and the pointer-specific one, with the
    // consumer's appended rather than replacing them.
    expect(popup().className).toBe('terminal-menu terminal-pointer-menu ops-runtime-menu');
    // There is no trigger element to portal out of; the popup still lands
    // beside the component's own container rather than inside it.
    expect(view.container.contains(popup())).toBe(false);
  });

  it('anchors the popup at the point it was given and follows the point when it moves', async () => {
    const menu = (x: number, y: number): ReactElement => (
      <TerminalPointerMenu
        open
        onOpenChange={vi.fn()}
        x={x}
        y={y}
        items={[{ id: 'a', label: 'Первый', onSelect: vi.fn() }]}
        label="Действия"
      />
    );
    const view = mount(menu(120, 80));
    await settle();
    const first = translation();
    /*
     * The anchor is a zero-sized rect at the point, so on the cross axis the
     * popup sits at the point itself. The main axis carries `sideOffset` and
     * the collision arithmetic, which jsdom's zero-sized viewport skews, so
     * only the displacement is asserted there.
     */
    expect(first.y).toBe(80);

    view.rerender(menu(300, 200));
    await settle();
    const second = translation();
    // A second right click elsewhere has to move the menu: the anchor is
    // memoised on `x`/`y`, and a stale one would pin every menu to the first point.
    expect(second.y).toBe(200);
    expect(second.x - first.x).toBe(180);
  });

  it('reports a close as a single boolean rather than passing Base UI details through', async () => {
    const onOpenChange = vi.fn();
    mount(
      <TerminalPointerMenu
        open
        onOpenChange={onOpenChange}
        x={120}
        y={80}
        items={[{ id: 'a', label: 'Первый', onSelect: vi.fn() }]}
        label="Действия"
      />,
    );
    await settle();

    act(() => {
      popup().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    // Base UI calls its handler with `(open, eventDetails)`; the runtime in
    // apps/hq takes one argument, so the extra one must not reach it.
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('maps each item onto an entry and calls only the one that was selected', async () => {
    const open = vi.fn();
    const copy = vi.fn();
    const remove = vi.fn();
    mount(
      <TerminalPointerMenu
        open
        onOpenChange={vi.fn()}
        x={120}
        y={80}
        items={[
          { id: 'open', label: 'Открыть', onSelect: open },
          { id: 'copy', label: 'Копировать', shortcut: 'Ctrl+C', tone: 'primary', onSelect: copy },
          { id: 'remove', label: 'Удалить', tone: 'critical', disabled: true, onSelect: remove },
        ]}
        label="Действия"
      />,
    );
    await settle();

    const rendered = entries();
    expect(rendered.map((entry) => entry.textContent)).toEqual([
      'Открыть',
      'КопироватьCtrl+C',
      'Удалить',
    ]);
    // An item that names no tone still carries one, so the stylesheet never has
    // to describe an entry without `data-tone`.
    expect(rendered.map((entry) => entry.getAttribute('data-tone'))).toEqual([
      'neutral',
      'primary',
      'critical',
    ]);
    expect(rendered.map((entry) => entry.querySelector('kbd')?.textContent ?? null)).toEqual([
      null,
      'Ctrl+C',
      null,
    ]);
    expect(rendered.map((entry) => entry.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
      'true',
    ]);

    const [, chosen, unavailable] = rendered;
    if (chosen === undefined || unavailable === undefined) throw new Error('entries missing');
    act(() => {
      unavailable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(remove).not.toHaveBeenCalled();

    act(() => {
      chosen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
