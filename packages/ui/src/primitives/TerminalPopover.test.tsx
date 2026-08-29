// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalButton } from './TerminalButton.js';
import { TerminalPopover } from './TerminalPopover.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns anchoring, dismissal and focus. This wrapper adds the `side`
 * default, the optional title and description slots, the class merge and the
 * always-present body, so those are what is asserted. jsdom performs no
 * layout, so the offset the wrapper pins (`sideOffset={5}`) is not observable
 * and is deliberately left untested.
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

function query(selector: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const missing = (selector: string): boolean => document.body.querySelector(selector) === null;

/*
 * The semantic class always leads; the utility classes primitives.css still
 * governs today sit after it and are not this wrapper's own contract, so
 * only the leading token of each part is pinned here.
 */
const semanticClasses = (elements: readonly Element[]): string[] =>
  elements.map((element) => element.className.split(' ')[0] ?? '');

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

const trigger = <TerminalButton>Настройки</TerminalButton>;

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalPopover', () => {
  it('anchors on the side asked for and falls back to bottom', () => {
    mount(
      <TerminalPopover trigger={trigger} defaultOpen>
        <p>Содержимое</p>
      </TerminalPopover>,
    );
    expect(query('.terminal-popover__positioner').dataset['side']).toBe('bottom');
    expect(query('.terminal-popover').dataset['side']).toBe('bottom');

    mount(
      <TerminalPopover trigger={trigger} side="right" defaultOpen>
        <p>Содержимое</p>
      </TerminalPopover>,
    );
    const positioners = document.body.querySelectorAll<HTMLElement>(
      '.terminal-popover__positioner',
    );
    expect(positioners[1]?.dataset['side']).toBe('right');
  });

  it('renders title and description when given and wires them as the popup name and description', () => {
    mount(
      <TerminalPopover
        trigger={trigger}
        title="Раскладка"
        description="Плитки перестраиваются немедленно."
        defaultOpen
      >
        <p data-testid="body-content">Содержимое</p>
      </TerminalPopover>,
    );

    const popup = query('.terminal-popover');
    const title = query('.terminal-popover__title');
    const description = query('.terminal-popover__description');
    expect(title.textContent).toBe('Раскладка');
    expect(popup.getAttribute('aria-labelledby')).toBe(title.id);
    expect(description.textContent).toBe('Плитки перестраиваются немедленно.');
    expect(popup.getAttribute('aria-describedby')).toBe(description.id);

    // Order matters: title, description, then the body the children go into.
    expect(semanticClasses(Array.from(popup.children))).toEqual([
      'terminal-popover__title',
      'terminal-popover__description',
      'terminal-popover__body',
    ]);
    expect(query('.terminal-popover__body').querySelector('[data-testid="body-content"]')).not.toBe(
      null,
    );
  });

  it('omits both slots when neither is given, leaving the popup unnamed but still bodied', () => {
    mount(
      <TerminalPopover trigger={trigger} defaultOpen>
        <p data-testid="body-content">Содержимое</p>
      </TerminalPopover>,
    );

    const popup = query('.terminal-popover');
    expect(missing('.terminal-popover__title')).toBe(true);
    expect(missing('.terminal-popover__description')).toBe(true);
    // Nothing to point at, so Base UI leaves the attributes off entirely.
    expect(popup.hasAttribute('aria-labelledby')).toBe(false);
    expect(popup.hasAttribute('aria-describedby')).toBe(false);
    expect(semanticClasses(Array.from(popup.children))).toEqual(['terminal-popover__body']);
    expect(query('.terminal-popover__body').querySelector('[data-testid="body-content"]')).not.toBe(
      null,
    );
  });

  it('merges className onto the popup, never onto the positioner', () => {
    mount(
      <TerminalPopover trigger={trigger} className="wide" defaultOpen>
        <p>Содержимое</p>
      </TerminalPopover>,
    );
    const popupClass = query('.terminal-popover').className;
    expect(popupClass.startsWith('terminal-popover ')).toBe(true);
    expect(popupClass.endsWith(' wide')).toBe(true);
    expect(
      query('.terminal-popover__positioner').className.startsWith('terminal-popover__positioner'),
    ).toBe(true);
  });

  it('reports both directions of the toggle through onOpenChange', () => {
    const onOpenChange = vi.fn();
    const container = mount(
      <TerminalPopover trigger={trigger} onOpenChange={onOpenChange}>
        <p>Содержимое</p>
      </TerminalPopover>,
    );
    const control = container.querySelector('button');
    if (control === null) throw new Error('trigger not rendered');
    expect(missing('.terminal-popover')).toBe(true);

    click(control);
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    expect(missing('.terminal-popover')).toBe(false);

    escape(query('.terminal-popover'));
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    expect(missing('.terminal-popover')).toBe(true);
  });
});
