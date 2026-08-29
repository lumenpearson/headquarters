// @vitest-environment jsdom
import { act, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalButton } from './TerminalButton.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI's `Button` is not under test here. What is under test is everything
 * the wrapper adds on top of it: the tone/size defaulting, the class list it
 * composes, the data attributes it stamps, and the props it lets through.
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

const button = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector('button');
  if (element === null) throw new Error('no button rendered');
  return element;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalButton', () => {
  it('defaults to the neutral medium variant in both the class list and the data attributes', () => {
    const rendered = button(mount(<TerminalButton>Готово</TerminalButton>));
    // `toContain` rather than an exact match: the semantic prefix is what the
    // stylesheet and every locator key off, and utility classes sit after it.
    expect(rendered.className).toContain(
      'hq-button terminal-button terminal-button--neutral terminal-button--medium',
    );
    expect(rendered.dataset['tone']).toBe('neutral');
    expect(rendered.dataset['size']).toBe('medium');
    expect(rendered.textContent).toBe('Готово');
  });

  it('names the variant in the class list and puts the caller class last, so it can win the cascade', () => {
    const rendered = button(
      mount(
        <TerminalButton tone="critical" size="large" className="hq-panel__action extra">
          Стоп
        </TerminalButton>,
      ),
    );
    expect(rendered.className).toContain(
      'hq-button terminal-button terminal-button--critical terminal-button--large',
    );
    expect(rendered.className.endsWith('hq-panel__action extra')).toBe(true);
    expect(rendered.dataset['tone']).toBe('critical');
    expect(rendered.dataset['size']).toBe('large');
  });

  it('forwards the props it does not consume, a caller type included', () => {
    const onClick = vi.fn();
    /*
     * Base UI's `useButton` also merges `type: "button"` for a native button, so
     * the wrapper's own default cannot be observed in the DOM. What this pins is
     * that the wrapper does not overwrite an explicit `type` with that default --
     * a submit button inside a form has to stay a submit button.
     */
    const rendered = button(
      mount(
        <TerminalButton type="submit" name="confirm" aria-describedby="hint" onClick={onClick}>
          Отправить
        </TerminalButton>,
      ),
    );
    expect(rendered.type).toBe('submit');
    expect(rendered.name).toBe('confirm');
    expect(rendered.getAttribute('aria-describedby')).toBe('hint');

    act(() => rendered.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('hands disabled through, so the element is disabled and no click reaches the handler', () => {
    const onClick = vi.fn();
    const rendered = button(
      mount(
        <TerminalButton disabled onClick={onClick}>
          Недоступно
        </TerminalButton>,
      ),
    );
    expect(rendered.disabled).toBe(true);
    act(() => rendered.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards its ref to the rendered button', () => {
    const seen = vi.fn<(element: HTMLElement | null) => void>();

    function Owner() {
      const reference = useRef<HTMLElement>(null);
      useEffect(() => {
        seen(reference.current);
      }, []);
      return (
        <TerminalButton ref={reference} className="target">
          Фокус
        </TerminalButton>
      );
    }

    const rendered = button(mount(<Owner />));
    expect(seen).toHaveBeenCalledWith(rendered);
  });
});
