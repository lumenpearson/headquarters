// @vitest-environment jsdom
import { Toast } from '@base-ui/react/toast';
import { act, useEffect } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalToastViewport, useTerminalToast } from './TerminalToast.js';
import type { TerminalToastOptions } from './TerminalToast.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the queue, the timers and the dismissal; asserted here is only
 * what `useTerminalToast` and `TerminalToastViewport` add -- the tone that
 * becomes the toast type and the `data-tone` the stylesheet reads, the class
 * names and nesting of every part, the Russian label on the close control, and
 * the per-toast timeout forwarded to the manager.
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

/** The hook only works under a provider, so a mounted consumer has to hand it out. */
function Harness() {
  const toast = useTerminalToast();
  // Handing it over from an effect rather than from render keeps the harness pure.
  useEffect(() => {
    manager = toast;
  });
  return null;
}

/** A bare Base UI provider, so nothing here depends on `TerminalUiProvider`'s own defaults. */
function mountViewport(): void {
  manager = undefined;
  mount(
    <Toast.Provider>
      <Harness />
      <TerminalToastViewport />
    </Toast.Provider>,
  );
}

function notify(options: TerminalToastOptions): void {
  if (manager === undefined) throw new Error('the toast hook never ran');
  const toastManager = manager;
  act(() => {
    toastManager.notify(options);
  });
}

/** Newest first, as the viewport stacks them. */
const rendered = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.terminal-toast'));

const titles = (): (string | null)[] =>
  rendered().map((toast) => toast.querySelector('.terminal-toast__title')?.textContent ?? null);

const at = (index: number): HTMLElement => {
  const toast = rendered()[index];
  if (toast === undefined) throw new Error(`no toast at ${index}`);
  return toast;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  manager = undefined;
  vi.useRealTimers();
});

describe('useTerminalToast', () => {
  it('stamps the tone the stylesheet reads onto each toast, defaulting it to neutral', () => {
    mountViewport();
    notify({ title: 'СБОЙ ПИТАНИЯ', tone: 'critical' });
    notify({ title: 'ГОТОВО' });

    expect(titles()).toEqual(['ГОТОВО', 'СБОЙ ПИТАНИЯ']);
    expect(at(0).getAttribute('data-tone')).toBe('neutral');
    expect(at(1).getAttribute('data-tone')).toBe('critical');
    expect(at(1).classList.contains('terminal-toast')).toBe(true);
  });

  it('forwards a per-toast timeout, leaving the provider default to the rest', () => {
    vi.useFakeTimers();
    mountViewport();
    notify({ title: 'КОРОТКОЕ', timeout: 100 });
    notify({ title: 'ОБЫЧНОЕ' });
    expect(titles()).toEqual(['ОБЫЧНОЕ', 'КОРОТКОЕ']);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Only the toast given its own timeout is gone; the provider's 5000 ms still runs.
    expect(titles()).toEqual(['ОБЫЧНОЕ']);
  });
});

describe('TerminalToastViewport', () => {
  it('wraps every part of a toast in the class names the stylesheet targets', () => {
    mountViewport();
    notify({ title: 'ТОЛЬКО ЗАГОЛОВОК' });
    notify({ title: 'С ОПИСАНИЕМ', description: 'КАНАЛ ВОССТАНОВЛЕН' });

    expect(document.querySelectorAll('.terminal-toast__viewport')).toHaveLength(1);
    const content = at(0).querySelector('.terminal-toast__content');
    if (content === null) throw new Error('content not rendered');
    expect(content.parentElement).toBe(at(0));
    expect(content.querySelector('.terminal-toast__title')?.textContent).toBe('С ОПИСАНИЕМ');
    expect(content.querySelector('.terminal-toast__description')?.textContent).toBe(
      'КАНАЛ ВОССТАНОВЛЕН',
    );
    expect(at(0).querySelector('.terminal-toast__close')?.parentElement).toBe(at(0));
    // Base UI drops a label part with no content on its own, so the viewport's
    // own `toast.description` guard is belt-and-braces rather than load-bearing.
    expect(at(1).querySelector('.terminal-toast__description')).toBeNull();
    expect(at(1).querySelector('.terminal-toast__title')?.textContent).toBe('ТОЛЬКО ЗАГОЛОВОК');
  });

  it('dismisses one toast from its own labelled close control', () => {
    mountViewport();
    notify({ title: 'ПЕРВЫЙ' });
    notify({ title: 'ВТОРОЙ' });
    notify({ title: 'ТРЕТИЙ' });

    const close = at(1).querySelector<HTMLElement>('.terminal-toast__close');
    if (close === null) throw new Error('close control not rendered');
    expect(close.getAttribute('aria-label')).toBe('Закрыть уведомление');
    expect(close.textContent).toBe('[×]');

    act(() => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(titles()).toEqual(['ТРЕТИЙ', 'ПЕРВЫЙ']);
  });
});
