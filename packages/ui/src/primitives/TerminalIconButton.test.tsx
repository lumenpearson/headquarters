// @vitest-environment jsdom
import { act, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalIconButton } from './TerminalIconButton.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * The wrapper is thin -- it delegates to `TerminalButton` -- but it is not a
 * re-export: it turns one `label` into both the accessible name and the native
 * tooltip of a control whose content is an icon, and it adds its own class.
 * Those three, plus the pass-through, are what is asserted here.
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

describe('TerminalIconButton', () => {
  it('gives the icon a name: one label becomes both the accessible name and the tooltip', () => {
    const rendered = button(
      mount(
        <TerminalIconButton label="Закрыть панель">
          <span aria-hidden="true">×</span>
        </TerminalIconButton>,
      ),
    );
    expect(rendered.getAttribute('aria-label')).toBe('Закрыть панель');
    expect(rendered.title).toBe('Закрыть панель');
    // The icon itself stays the content and stays out of the accessibility tree.
    expect(rendered.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.textContent).toBe('×');
  });

  it('adds its own class between the button base classes and the caller class', () => {
    const rendered = button(
      mount(
        <TerminalIconButton label="Свернуть" tone="quiet" size="small" className="hq-toolbar__icon">
          <span>-</span>
        </TerminalIconButton>,
      ),
    );
    expect(rendered.className).toBe(
      'hq-button terminal-button terminal-button--quiet terminal-button--small terminal-icon-button hq-toolbar__icon',
    );
    // Tone and size are not consumed here: they have to reach TerminalButton.
    expect(rendered.dataset['tone']).toBe('quiet');
    expect(rendered.dataset['size']).toBe('small');
  });

  it('lets label win over an aria-label the caller passed, because label is the API', () => {
    const rendered = button(
      mount(
        <TerminalIconButton label="Удалить материал" aria-label="Удалить">
          <span>x</span>
        </TerminalIconButton>,
      ),
    );
    expect(rendered.getAttribute('aria-label')).toBe('Удалить материал');
  });

  it('forwards the remaining props down to the button element', () => {
    const onClick = vi.fn();
    const rendered = button(
      mount(
        <TerminalIconButton label="Обновить" onClick={onClick} data-cue="refresh">
          <span>@</span>
        </TerminalIconButton>,
      ),
    );
    expect(rendered.dataset['cue']).toBe('refresh');
    act(() => rendered.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards its ref through to the button, although it declares no forwardRef of its own', () => {
    const seen = vi.fn<(element: HTMLButtonElement | null) => void>();

    function Owner() {
      const reference = useRef<HTMLButtonElement>(null);
      useEffect(() => {
        seen(reference.current);
      }, []);
      return (
        <TerminalIconButton ref={reference} label="Фокус">
          <span>o</span>
        </TerminalIconButton>
      );
    }

    const rendered = button(mount(<Owner />));
    expect(seen).toHaveBeenCalledWith(rendered);
  });
});
