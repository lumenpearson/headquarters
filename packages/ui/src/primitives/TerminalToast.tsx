'use client';

import { Toast } from '@base-ui/react/toast';
import type { ReactNode } from 'react';

export type TerminalToastTone = 'neutral' | 'success' | 'warning' | 'critical' | 'progress';

export interface TerminalToastData {
  readonly tone?: TerminalToastTone;
}

export interface TerminalToastOptions {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: TerminalToastTone;
  readonly timeout?: number;
  readonly priority?: 'low' | 'high';
}

export function useTerminalToast() {
  const toastManager = Toast.useToastManager<TerminalToastData>();

  return {
    notify(options: TerminalToastOptions) {
      return toastManager.add({
        title: options.title,
        description: options.description,
        type: options.tone ?? 'neutral',
        timeout: options.timeout,
        priority: options.priority,
        data: { tone: options.tone ?? 'neutral' },
      });
    },
    close: toastManager.close,
    update: toastManager.update,
    promise: toastManager.promise,
  } as const;
}

export function TerminalToastViewport() {
  const { toasts } = Toast.useToastManager<TerminalToastData>();

  return (
    <Toast.Portal>
      <Toast.Viewport className="terminal-toast__viewport fixed z-[calc(var(--z-popup)_+_1)] right-[var(--space-4)] bottom-[var(--space-4)] flex w-[min(380px,calc(100vw_-_32px))] max-h-[calc(100dvh_-_32px)] flex-col gap-hq-2 outline-none pointer-events-none">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            /*
             * The per-tone `border-left-color` stays in primitives.css
             * (`.terminal-toast[data-tone=...]`): it is unlayered there, so it
             * always outranks a Tailwind utility regardless of specificity.
             * The neutral default it overrides, `border-l-hq-accent`, is safe
             * to migrate -- the override stays authoritative either way.
             */
            className="terminal-toast grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] gap-hq-2 p-hq-3 border border-hq-line-2 border-l-[3px] border-l-hq-accent bg-hq-bg-1 text-hq-text-0 pointer-events-auto transition-[opacity,transform] duration-hq-standard [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:translate-x-[12px] data-[ending-style]:opacity-0 data-[ending-style]:translate-x-[12px]"
            data-tone={toast.type}
          >
            <Toast.Content className="terminal-toast__content min-w-0">
              {toast.title ? (
                <Toast.Title className="terminal-toast__title block [overflow-wrap:anywhere] text-hq-sm font-bold tracking-[0.05em] uppercase" />
              ) : null}
              {toast.description ? (
                <Toast.Description className="terminal-toast__description block [overflow-wrap:anywhere] mt-[var(--space-1)] text-hq-text-1 [font-family:var(--font-mono)] text-[length:var(--ops-font-size,var(--font-xs))]" />
              ) : null}
            </Toast.Content>
            <Toast.Close
              className="terminal-toast__close self-start border-0 outline-none bg-transparent text-hq-text-1 cursor-pointer [font:inherit] hover:text-hq-accent focus-visible:text-hq-accent"
              aria-label="Закрыть уведомление"
            >
              [×]
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
