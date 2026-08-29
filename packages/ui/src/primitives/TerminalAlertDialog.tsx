'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { ReactElement, ReactNode } from 'react';

import { classNames } from './classNames.js';
import { TerminalButton } from './TerminalButton.js';
import {
  TERMINAL_DIALOG_BACKDROP_UTILITY,
  TERMINAL_DIALOG_DESCRIPTION_UTILITY,
  TERMINAL_DIALOG_FOOTER_UTILITY,
  TERMINAL_DIALOG_HEADER_UTILITY,
  TERMINAL_DIALOG_POPUP_UTILITY,
} from './terminalOverlayStyles.js';

/*
 * `.terminal-alert-dialog` borrows `.terminal-dialog`'s whole skin
 * (`TERMINAL_DIALOG_POPUP_UTILITY`) and swaps only its size for a shorter
 * grid and a narrower width. `.terminal-alert-dialog > .terminal-dialog__header
 * > h2` is simpler than `TerminalDialog`'s own heading (no eyebrow row, no
 * letter-spacing), so it stays local to `AlertDialog.Title` instead of a
 * shared constant.
 */
const TERMINAL_ALERT_DIALOG_SIZE_UTILITY =
  'grid-rows-[auto_minmax(0,1fr)_auto] w-[min(520px,calc(100vw_-_32px))]';

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
        <AlertDialog.Backdrop
          className={classNames('terminal-dialog__backdrop', TERMINAL_DIALOG_BACKDROP_UTILITY)}
        />
        <AlertDialog.Viewport className="terminal-dialog__viewport fixed z-[calc(var(--z-dialog)_+_1)] inset-0 grid min-w-0 min-h-0 place-items-center p-hq-4">
          <AlertDialog.Popup
            className={classNames(
              'terminal-dialog',
              'terminal-alert-dialog',
              TERMINAL_DIALOG_POPUP_UTILITY,
              TERMINAL_ALERT_DIALOG_SIZE_UTILITY,
            )}
          >
            <header
              className={classNames('terminal-dialog__header', TERMINAL_DIALOG_HEADER_UTILITY)}
            >
              <AlertDialog.Title className="m-0 text-hq-md">{title}</AlertDialog.Title>
            </header>
            <AlertDialog.Description
              className={classNames(
                'terminal-dialog__description',
                TERMINAL_DIALOG_DESCRIPTION_UTILITY,
              )}
            >
              {description}
            </AlertDialog.Description>
            <footer
              className={classNames('terminal-dialog__footer', TERMINAL_DIALOG_FOOTER_UTILITY)}
            >
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
