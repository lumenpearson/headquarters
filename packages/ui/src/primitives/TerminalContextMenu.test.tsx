// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TerminalContextMenu } from './TerminalContextMenu.js';
import type { TerminalMenuItem } from './TerminalMenu.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI opens the menu on the right button and positions it; that is not
 * asserted here. This wrapper's own are the `data-context-menu-own` marker the
 * application-wide right-click runtime walks up to, the two class names it
 * puts on the popup, and the same item mapping `TerminalMenu` performs.
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

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
    button: 2,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const triggerOf = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('section');
  if (element === null) throw new Error('trigger not rendered');
  return element;
};

const popup = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[role="menu"]');
  if (element === null) throw new Error('menu popup not open');
  return element;
};

const entries = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

const singleItem: readonly TerminalMenuItem[] = [{ id: 'a', label: 'Первый', onSelect: () => {} }];

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

describe('TerminalContextMenu', () => {
  it('marks its trigger as already owning the right button, on the element the consumer supplied', () => {
    const container = mount(
      <TerminalContextMenu
        trigger={
          <section className="ops-card" data-owner="case">
            <span data-inner="">Материал</span>
          </section>
        }
        items={singleItem}
        label="Действия с материалом"
      />,
    );
    const trigger = triggerOf(container);
    expect(trigger.className).toBe('ops-card');
    expect(trigger.getAttribute('data-owner')).toBe('case');
    /*
     * `ContextMenuRuntime` in apps/hq walks up from the event target with
     * `closest('[data-context-menu], [data-context-menu-own]')` and stops here
     * without naming a surface, so no second menu opens over this one. The
     * value must stay empty: the selector is attribute-presence only, and the
     * runtime reads `data-context-menu` off whatever it finds.
     */
    expect(trigger.getAttribute('data-context-menu-own')).toBe('');
    expect(trigger.hasAttribute('data-context-menu')).toBe(false);
    const inner = container.querySelector('[data-inner]');
    expect(inner?.closest('[data-context-menu], [data-context-menu-own]')).toBe(trigger);
  });

  it('opens a portalled menu on the contextmenu event, labelled and classed as a context menu', async () => {
    const container = mount(
      <TerminalContextMenu
        trigger={<section>Материал</section>}
        items={singleItem}
        label="Действия с материалом"
        className="ops-card__menu"
      />,
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();

    const event = rightClick(triggerOf(container));
    await settle();

    /*
     * The premise behind `data-context-menu-own`: this trigger really does
     * answer the right button and suppress the browser's own menu, so a second
     * menu opened by the application-wide runtime would land on top of this one.
     */
    expect(event.defaultPrevented).toBe(true);
    expect(popup().getAttribute('aria-label')).toBe('Действия с материалом');
    // Both the shared menu class and the context-specific one lead, and the
    // consumer's own trails after the utility classes primitives.css still
    // governs today; none of the three replace one another.
    const popupClass = popup().className;
    expect(popupClass.startsWith('terminal-menu terminal-context-menu ')).toBe(true);
    expect(popupClass.endsWith(' ops-card__menu')).toBe(true);
    // Portalled out of the trigger's subtree, so an ancestor's overflow cannot clip it.
    expect(container.contains(popup())).toBe(false);
    expect(popup().closest('.terminal-menu__positioner')).not.toBeNull();
  });

  it('maps each item onto an entry: default tone, optional shortcut, disabled state', async () => {
    const container = mount(
      <TerminalContextMenu
        trigger={<section>Материал</section>}
        items={[
          { id: 'plain', label: 'Открыть', onSelect: vi.fn() },
          { id: 'shortcut', label: 'Копировать', shortcut: 'Ctrl+C', onSelect: vi.fn() },
          {
            id: 'off',
            label: 'Удалить',
            shortcut: 'Del',
            tone: 'critical',
            disabled: true,
            onSelect: vi.fn(),
          },
        ]}
        label="Действия с материалом"
      />,
    );
    rightClick(triggerOf(container));
    await settle();

    const rendered = entries();
    expect(rendered.map((entry) => entry.textContent)).toEqual([
      'Открыть',
      'КопироватьCtrl+C',
      'УдалитьDel',
    ]);
    // An item that names no tone still carries one, so the stylesheet never has
    // to describe an entry without `data-tone`.
    expect(rendered.map((entry) => entry.getAttribute('data-tone'))).toEqual([
      'neutral',
      'neutral',
      'critical',
    ]);
    expect(rendered.map((entry) => entry.querySelector('kbd')?.textContent ?? null)).toEqual([
      null,
      'Ctrl+C',
      'Del',
    ]);
    expect(rendered.map((entry) => entry.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
      'true',
    ]);
  });

  it('calls the selected item and only that item, and never a disabled one', async () => {
    const open = vi.fn();
    const copy = vi.fn();
    const remove = vi.fn();
    const container = mount(
      <TerminalContextMenu
        trigger={<section>Материал</section>}
        items={[
          { id: 'open', label: 'Открыть', onSelect: open },
          { id: 'copy', label: 'Копировать', onSelect: copy },
          { id: 'remove', label: 'Удалить', disabled: true, onSelect: remove },
        ]}
        label="Действия с материалом"
      />,
    );
    rightClick(triggerOf(container));
    await settle();

    const [, chosen, unavailable] = entries();
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
