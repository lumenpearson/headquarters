// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalScrollArea } from './TerminalScrollArea.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and read the DOM it
 * produces, and they are already dependencies of the package.
 *
 * TerminalScrollArea is a thin wrapper. It maps no props, forwards no ref,
 * wires no handler and performs no defaulting: everything that scrolls belongs
 * to Base UI. All it owns is the assembly -- which parts are present, how they
 * nest, and which of the three class-name slots each consumer class reaches --
 * so that is all these tests assert, and they are change detectors by nature.
 *
 * The scrollbar, thumb and corner it renders are deliberately not asserted:
 * Base UI mounts them only once it has measured overflow, which jsdom, having
 * no layout, never reports.
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

function query(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalScrollArea', () => {
  it('puts the children in the content wrapper, nested inside the viewport and the root', () => {
    const container = mount(
      <TerminalScrollArea>
        <p id="first">Первая строка</p>
        <p id="second">Вторая строка</p>
      </TerminalScrollArea>,
    );
    const root = query(container, '.terminal-scroll-area');
    const viewport = query(container, '.terminal-scroll-area__viewport');
    const content = query(container, '.terminal-scroll-area__content');

    expect(viewport.parentElement).toBe(root);
    expect(content.parentElement).toBe(viewport);
    // Base UI observes the content wrapper for resizes, so the children must sit inside it.
    expect(query(container, '#first').parentElement).toBe(content);
    expect(query(container, '#second').parentElement).toBe(content);
    expect(content.children).toHaveLength(2);
  });

  it('sends each consumer class to its own slot and leaves the others at their default', () => {
    const dressed = mount(
      <TerminalScrollArea
        className="hq-log"
        viewportClassName="hq-log__viewport"
        contentClassName="hq-log__content"
      >
        <span />
      </TerminalScrollArea>,
    );
    expect(query(dressed, '.terminal-scroll-area').className).toBe(
      'terminal-scroll-area group relative min-w-0 min-h-0 overflow-hidden hq-log',
    );
    expect(query(dressed, '.terminal-scroll-area__content').className).toBe(
      'terminal-scroll-area__content min-w-full hq-log__content',
    );
    /*
     * The viewport is the one part Base UI adds a class of its own to, so it is
     * checked by membership: what matters is that the viewport class reached
     * the viewport and nowhere else.
     */
    const viewport = query(dressed, '.terminal-scroll-area__viewport');
    expect(viewport.classList.contains('hq-log__viewport')).toBe(true);
    expect(
      query(dressed, '.terminal-scroll-area__content').classList.contains('hq-log__viewport'),
    ).toBe(false);

    // Omitted slots keep the bare class, with no separator left behind.
    const bare = mount(
      <TerminalScrollArea viewportClassName="hq-log__viewport">
        <span />
      </TerminalScrollArea>,
    );
    expect(query(bare, '.terminal-scroll-area').className).toBe(
      'terminal-scroll-area group relative min-w-0 min-h-0 overflow-hidden',
    );
    expect(query(bare, '.terminal-scroll-area__content').className).toBe(
      'terminal-scroll-area__content min-w-full',
    );
  });
});
