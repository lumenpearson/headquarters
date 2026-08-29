// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalButton } from './TerminalButton.js';
import { TerminalDialog, TerminalDrawer } from './TerminalDialog.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the overlay itself -- focus trapping, the portal, dismissal.
 * What is asserted here is only what these two wrappers add on top of it: the
 * region layout and its optional parts, the class merge, the close control's
 * label and default, and which of `onOpenChange` / `onClose` the consumer is
 * actually told about.
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

/** Everything but the trigger is portalled to `document.body`, so queries start there. */
function query(selector: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const missing = (selector: string): boolean => document.body.querySelector(selector) === null;

const classes = (element: Element): string[] => Array.from(element.classList);

/*
 * `toEqual` on the full class list would pin the exact set of utility
 * classes the wrapper appends alongside its semantic one -- an
 * implementation detail primitives.css still governs today. What is this
 * wrapper's own contract is that the semantic class leads and the caller's
 * class trails, so only those two ends are asserted.
 */
const hasClasses = (element: Element, semantic: string, trailing?: string): boolean => {
  const className = element.className;
  return trailing === undefined
    ? className === semantic || className.startsWith(`${semantic} `)
    : className.startsWith(`${semantic} `) && className.endsWith(` ${trailing}`);
};

function click(element: Element): void {
  act(() => (element as HTMLElement).click());
}

function escape(element: Element): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
}

const closeButton = (): HTMLElement => query('button[aria-label="Закрыть"]');

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalDialog', () => {
  it('lays the popup out in named regions and omits every optional one it was not given', () => {
    mount(
      <TerminalDialog
        title="Заголовок"
        eyebrow="ПРОТОКОЛ"
        description="Пояснение"
        footer={<span data-testid="footer-content">Действия</span>}
        className="extra"
        defaultOpen
      >
        <p data-testid="body-content">Содержимое</p>
      </TerminalDialog>,
    );

    const popup = query('[role="dialog"]');
    expect(hasClasses(popup, 'terminal-dialog', 'extra')).toBe(true);
    expect(query('.terminal-dialog__viewport').contains(popup)).toBe(true);
    expect(missing('.terminal-dialog__backdrop')).toBe(false);

    const heading = query('.terminal-dialog__heading');
    expect(Array.from(heading.children).map((child) => child.tagName)).toEqual(['SPAN', 'H2']);
    expect(heading.children[0]?.textContent).toBe('ПРОТОКОЛ');

    // The title names the popup; the eyebrow is decoration and stays out of the name.
    const title = query('.terminal-dialog__heading h2');
    expect(popup.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.textContent).toBe('Заголовок');

    const description = query('.terminal-dialog__description');
    expect(popup.getAttribute('aria-describedby')).toBe(description.id);

    expect(query('.terminal-dialog__body').querySelector('[data-testid="body-content"]')).not.toBe(
      null,
    );
    const footer = query('footer.terminal-dialog__footer');
    expect(footer.querySelector('[data-testid="footer-content"]')).not.toBe(null);
  });

  it('renders neither eyebrow, description nor footer when they are absent', () => {
    mount(
      <TerminalDialog title="Заголовок" defaultOpen>
        <p data-testid="body-content">Содержимое</p>
      </TerminalDialog>,
    );

    const popup = query('[role="dialog"]');
    expect(hasClasses(popup, 'terminal-dialog')).toBe(true);
    expect(query('.terminal-dialog__heading').querySelector('span')).toBe(null);
    expect(missing('.terminal-dialog__description')).toBe(true);
    expect(missing('.terminal-dialog__footer')).toBe(true);
    // No description element means nothing to point `aria-describedby` at.
    expect(popup.hasAttribute('aria-describedby')).toBe(false);
    expect(query('.terminal-dialog__body').querySelector('[data-testid="body-content"]')).not.toBe(
      null,
    );
  });

  it('labels the close control with closeLabel, defaulting to Закрыть, without touching its caption', () => {
    mount(
      <TerminalDialog title="Заголовок" defaultOpen>
        <p>Содержимое</p>
      </TerminalDialog>,
    );
    const fallback = closeButton();
    expect(fallback.dataset['tone']).toBe('quiet');
    expect(fallback.dataset['size']).toBe('small');
    /*
     * The caption is a keyboard hint, not the accessible name: `aria-label`
     * replaces it outright, so the two share no words. See the report on
     * WCAG 2.5.3 that accompanies these tests.
     */
    expect(fallback.textContent).toBe('[ESC] CLOSE');

    mount(
      <TerminalDialog title="Заголовок" closeLabel="Свернуть панель" defaultOpen>
        <p>Содержимое</p>
      </TerminalDialog>,
    );
    const relabelled = query('button[aria-label="Свернуть панель"]');
    expect(relabelled.textContent).toBe('[ESC] CLOSE');
  });

  it('reports a close through onOpenChange and, when open is controlled, leaves the state to the owner', () => {
    const uncontrolled = vi.fn();
    mount(
      <TerminalDialog title="Заголовок" defaultOpen onOpenChange={uncontrolled}>
        <p>Содержимое</p>
      </TerminalDialog>,
    );
    click(closeButton());
    expect(uncontrolled.mock.calls).toEqual([[false]]);
    expect(missing('[role="dialog"]')).toBe(true);

    const controlled = vi.fn();
    mount(
      <TerminalDialog title="Заголовок" open onOpenChange={controlled}>
        <p>Содержимое</p>
      </TerminalDialog>,
    );
    click(closeButton());
    expect(controlled.mock.calls).toEqual([[false]]);
    // The wrapper keeps no state of its own: the popup stands until `open` flips.
    expect(missing('[role="dialog"]')).toBe(false);
  });

  it('renders a trigger only when one is supplied, and opens from it', () => {
    const withoutTrigger = mount(
      <TerminalDialog title="Заголовок">
        <p>Содержимое</p>
      </TerminalDialog>,
    );
    expect(withoutTrigger.querySelector('[aria-haspopup="dialog"]')).toBe(null);
    expect(missing('[role="dialog"]')).toBe(true);

    const onOpenChange = vi.fn();
    const withTrigger = mount(
      <TerminalDialog
        title="Заголовок"
        trigger={<TerminalButton>Открыть</TerminalButton>}
        onOpenChange={onOpenChange}
      >
        <p>Содержимое</p>
      </TerminalDialog>,
    );
    const trigger = withTrigger.querySelector<HTMLElement>('[aria-haspopup="dialog"]');
    // The trigger is the consumer's own element, kept intact and merely wired up.
    expect(trigger?.className).toContain('terminal-button--neutral');
    expect(trigger?.textContent).toBe('Открыть');
    click(trigger as Element);
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    expect(missing('[role="dialog"]')).toBe(false);
  });
});

describe('TerminalDrawer', () => {
  it('renders an aside panel with a strong title and merges bodyClassName separately', () => {
    mount(
      <TerminalDrawer
        title="Заголовок"
        eyebrow="ПРОТОКОЛ"
        onClose={vi.fn()}
        className="panel"
        bodyClassName="scroll"
      >
        <p data-testid="body-content">Содержимое</p>
      </TerminalDrawer>,
    );

    const panel = query('[role="dialog"]');
    expect(panel.tagName).toBe('ASIDE');
    expect(hasClasses(panel, 'terminal-drawer', 'panel')).toBe(true);
    expect(missing('.terminal-drawer__backdrop')).toBe(false);
    // The drawer is its own viewport; only TerminalDialog wraps one.
    expect(missing('.terminal-dialog__viewport')).toBe(true);

    const title = query('.terminal-drawer strong');
    expect(title.textContent).toBe('Заголовок');
    expect(panel.getAttribute('aria-labelledby')).toBe(title.id);
    expect(panel.querySelector('header span')?.textContent).toBe('ПРОТОКОЛ');

    const body = query('.terminal-drawer__body');
    expect(classes(body)).toEqual(['terminal-drawer__body', 'scroll']);
    expect(body.querySelector('[data-testid="body-content"]')).not.toBe(null);
  });

  it('stays open and asks the owner to close it, once per dismissal', () => {
    const onClose = vi.fn();
    mount(
      <TerminalDrawer title="Заголовок" eyebrow="ПРОТОКОЛ" onClose={onClose}>
        <p>Содержимое</p>
      </TerminalDrawer>,
    );

    click(closeButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    // `open` is hard-wired: the panel cannot hide itself, so the owner must unmount it.
    expect(missing('aside.terminal-drawer')).toBe(false);

    escape(query('aside.terminal-drawer'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(missing('aside.terminal-drawer')).toBe(false);
  });
});
