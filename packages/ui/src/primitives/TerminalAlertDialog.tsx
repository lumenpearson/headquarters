'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { ReactElement, ReactNode } from 'react';

import { TerminalButton } from './TerminalButton.js';

export interface TerminalAlertDialogProps {
  readonly trigger: ReactElement;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly cancelLabel?: string;
  readonly tone?: 'primary' | 'critical';
}

export function TerminalAlertDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  cancelLabel = 'ОТМЕНА',
  tone = 'critical',
}: TerminalAlertDialogProps) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={trigger} />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="terminal-dialog__backdrop" />
        <AlertDialog.Viewport className="terminal-dialog__viewport">
          <AlertDialog.Popup className="terminal-dialog terminal-alert-dialog">
            <header className="terminal-dialog__header">
              <AlertDialog.Title>{title}</AlertDialog.Title>
            </header>
            <AlertDialog.Description className="terminal-dialog__description">
              {description}
            </AlertDialog.Description>
            <footer className="terminal-dialog__footer">
              <AlertDialog.Close render={<TerminalButton>{cancelLabel}</TerminalButton>} />
              <AlertDialog.Close
                render={
                  <TerminalButton tone={tone} onClick={onConfirm}>
                    {confirmLabel}
                  </TerminalButton>
                }
              />
            </footer>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
