// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalTooltip } from './TerminalTooltip.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns when a tooltip opens; asserted here is only what this wrapper
 * adds on top -- the trigger it builds out of `children`, the class names and
 * `role` it writes, the side it maps, and the `disabled` it forwards.
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

/** Both portalled popups and triggers are queried document-wide, so no tree may outlive its test. */
function unmountAll(): void {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
}

const triggerOf = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('button');
  if (element === null) throw new Error('trigger not rendered');
  return element;
};

/**
 * Base UI treats jsdom as always focus-visible, so focusing the trigger opens
 * the tooltip synchronously -- there is no hover delay to wind forward.
 */
function open(container: HTMLElement): void {
  const trigger = triggerOf(container);
  act(() => trigger.focus());
}

const popup = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.terminal-tooltip');
  if (element === null) throw new Error('popup not rendered');
  return element;
};

const positioner = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.terminal-tooltip__positioner');
  if (element === null) throw new Error('positioner not rendered');
  return element;
};

afterEach(unmountAll);

describe('TerminalTooltip', () => {
  it('turns the child itself into the trigger and labels the popup it opens', () => {
    const container = mount(
      <TerminalTooltip label="Подсказка">
        <button type="button" id="scan" data-role="probe">
          СКАН
        </button>
      </TerminalTooltip>,
    );

    // `render={children}` means the child is the trigger: no wrapper button is
    // introduced and the child keeps every prop it was given.
    expect(container.querySelectorAll('button')).toHaveLength(1);
    const trigger = triggerOf(container);
    expect(trigger.id).toBe('scan');
    expect(trigger.getAttribute('data-role')).toBe('probe');
    expect(trigger.textContent).toBe('СКАН');
    expect(trigger.hasAttribute('data-base-ui-tooltip-trigger')).toBe(true);

    open(container);
    // Base UI gives the popup no role of its own; the wrapper supplies it.
    expect(popup().getAttribute('role')).toBe('tooltip');
    expect(popup().textContent).toBe('Подсказка');
    expect(positioner().className).toBe('terminal-tooltip__positioner');
  });

  it('appends the consumer class after its own and leaves no gap when there is none', () => {
    const bare = mount(
      <TerminalTooltip label="Без класса">
        <button type="button">A</button>
      </TerminalTooltip>,
    );
    open(bare);
    expect(popup().className).toBe('terminal-tooltip');
    unmountAll();

    const dressed = mount(
      <TerminalTooltip label="С классом" className="gallery-hint">
        <button type="button">B</button>
      </TerminalTooltip>,
    );
    open(dressed);
    expect(popup().className).toBe('terminal-tooltip gallery-hint');
  });

  it('places the popup on the side it was asked for, and above the trigger by default', () => {
    const left = mount(
      <TerminalTooltip label="Слева" side="left">
        <button type="button">A</button>
      </TerminalTooltip>,
    );
    open(left);
    expect(positioner().getAttribute('data-side')).toBe('left');
    expect(popup().getAttribute('data-side')).toBe('left');
    unmountAll();

    const container = mount(
      <TerminalTooltip label="Сверху">
        <button type="button">B</button>
      </TerminalTooltip>,
    );
    open(container);
    expect(positioner().getAttribute('data-side')).toBe('top');
  });

  it('keeps the popup shut while disabled and says so on the trigger', () => {
    const container = mount(
      <TerminalTooltip label="Недоступно" disabled>
        <button type="button">A</button>
      </TerminalTooltip>,
    );
    // The trigger reads `disabled` off the root, so both attributes prove the
    // prop reached `Tooltip.Root` rather than being dropped.
    const trigger = triggerOf(container);
    expect(trigger.getAttribute('data-trigger-disabled')).toBe('');
    expect(trigger.hasAttribute('data-base-ui-tooltip-trigger')).toBe(false);

    open(container);
    expect(document.querySelector('.terminal-tooltip')).toBeNull();
  });
});
