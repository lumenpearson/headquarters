// @vitest-environment jsdom
import { act, useEffect } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTerminalToast } from './TerminalToast.js';
import { TerminalTooltip } from './TerminalTooltip.js';
import { TerminalUiProvider } from './TerminalUiProvider.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * The provider renders no markup of its own, so what is asserted here is the
 * wiring it performs for everything below it: the toast viewport it mounts
 * unasked, the four-toast limit, and the shared 450 ms tooltip hover delay
 * (Base UI's own default is 600 ms, and its toast limit is three).
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

let manager: ReturnType<typeof useTerminalToast> | undefined;

/** Only a mounted consumer can reach the toast manager the provider installs. */
function Consumer() {
  const toast = useTerminalToast();
  // Handing it over from an effect rather than from render keeps the consumer pure.
  useEffect(() => {
    manager = toast;
  });
  return <span className="child">ПУЛЬТ</span>;
}

function notify(title: string): void {
  if (manager === undefined) throw new Error('the toast hook never ran');
  const toastManager = manager;
  act(() => {
    toastManager.notify({ title });
  });
}

const titles = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.terminal-toast')).map(
    (toast) => toast.querySelector('.terminal-toast__title')?.textContent ?? null,
  );

const tooltipIsOpen = (): boolean => document.querySelector('.terminal-tooltip') !== null;

/**
 * Base UI opens a hovered tooltip only once the pointer has rested for the
 * group's delay, and only for a mouse-like pointer: the pointer event sets the
 * type, the native `mouseenter` arms the trigger, and the move starts the rest
 * timer that the delay is measured on.
 */
function hover(trigger: HTMLElement): void {
  const PointerEventConstructor: typeof MouseEvent =
    typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  act(() => {
    trigger.dispatchEvent(
      new PointerEventConstructor('pointerover', {
        bubbles: true,
        ...({ pointerType: 'mouse', pointerId: 1 } as PointerEventInit),
      }),
    );
    trigger.dispatchEvent(new MouseEvent('mouseenter'));
    trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  manager = undefined;
  vi.useRealTimers();
});

describe('TerminalUiProvider', () => {
  it('mounts the toast viewport beside its children, so a consumer only has to notify', () => {
    const container = mount(
      <TerminalUiProvider>
        <Consumer />
      </TerminalUiProvider>,
    );

    expect(container.querySelector('.child')?.textContent).toBe('ПУЛЬТ');
    expect(document.querySelectorAll('.terminal-toast__viewport')).toHaveLength(1);
    expect(titles()).toEqual([]);

    notify('СВЯЗЬ ВОССТАНОВЛЕНА');
    expect(titles()).toEqual(['СВЯЗЬ ВОССТАНОВЛЕНА']);
  });

  it('keeps four toasts on screen and pushes the oldest out of the way', () => {
    mount(
      <TerminalUiProvider>
        <Consumer />
      </TerminalUiProvider>,
    );

    for (const title of ['ПЕРВЫЙ', 'ВТОРОЙ', 'ТРЕТИЙ', 'ЧЕТВЁРТЫЙ']) notify(title);
    expect(document.querySelectorAll('.terminal-toast[data-limited]')).toHaveLength(0);

    notify('ПЯТЫЙ');
    // Over the limit Base UI marks the surplus rather than dropping it, so the
    // count of marked toasts is what the configured limit is readable from.
    const limited = document.querySelectorAll('.terminal-toast[data-limited]');
    expect(limited).toHaveLength(1);
    expect(limited[0]?.querySelector('.terminal-toast__title')?.textContent).toBe('ПЕРВЫЙ');
  });

  it('holds a hovered tooltip shut for the 450 ms it shares with every tooltip below it', () => {
    vi.useFakeTimers();
    const container = mount(
      <TerminalUiProvider>
        <TerminalTooltip label="Подсказка">
          <button type="button">СКАН</button>
        </TerminalTooltip>
      </TerminalUiProvider>,
    );
    const trigger = container.querySelector<HTMLElement>('button');
    if (trigger === null) throw new Error('trigger not rendered');

    hover(trigger);
    expect(tooltipIsOpen()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(449);
    });
    expect(tooltipIsOpen()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(tooltipIsOpen()).toBe(true);
  });
});
