// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalSeparator } from './TerminalSeparator.js';

/*
 * `TerminalSeparator` is a thin wrapper: over Base UI's `Separator` it adds one
 * class name and an orientation default, and it exposes no state, no callback
 * and no ref prop of its own (its props are `className` and `orientation`, so
 * a ref cannot even be typed through it). Coverage here is therefore a change
 * detector over the contract it does carry, not a test of behaviour that could
 * regress on its own.
 *
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive, and they are already
 * dependencies of the package.
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

const separator = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('[role="separator"]');
  if (element === null) throw new Error('separator not rendered');
  return element;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalSeparator', () => {
  it("keeps its own class name ahead of the consumer's", () => {
    const container = mount(<TerminalSeparator className="terminal-panel__rule" />);
    // The order matters: the design-system class must not be able to win the
    // cascade against the class the consumer passed to override it.
    const rendered = separator(container).getAttribute('class') ?? '';
    expect(rendered.startsWith('terminal-separator')).toBe(true);
    expect(rendered.endsWith('terminal-panel__rule')).toBe(true);
  });

  it('carries its own class first when the consumer passes none', () => {
    const container = mount(<TerminalSeparator />);
    expect(separator(container).getAttribute('class')).toContain('terminal-separator');
  });

  it('forwards a vertical orientation to the rendered separator', () => {
    // Only the vertical case can fail: Base UI's own default is horizontal, so
    // dropping this wrapper's default would leave the horizontal case intact.
    const vertical = mount(<TerminalSeparator orientation="vertical" />);
    expect(separator(vertical).getAttribute('aria-orientation')).toBe('vertical');
    const horizontal = mount(<TerminalSeparator />);
    expect(separator(horizontal).getAttribute('aria-orientation')).toBe('horizontal');
  });
});
