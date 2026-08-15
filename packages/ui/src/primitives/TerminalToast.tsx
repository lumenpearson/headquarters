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
      <Toast.Viewport className="terminal-toast__viewport">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className="terminal-toast"
            data-tone={toast.type}
          >
            <Toast.Content className="terminal-toast__content">
              {toast.title ? <Toast.Title className="terminal-toast__title" /> : null}
              {toast.description ? (
                <Toast.Description className="terminal-toast__description" />
              ) : null}
            </Toast.Content>
            <Toast.Close className="terminal-toast__close" aria-label="Закрыть уведомление">
              [×]
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
