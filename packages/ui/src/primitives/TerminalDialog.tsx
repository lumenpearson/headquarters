'use client';

import { Dialog } from '@base-ui/react/dialog';
import type { ReactElement, ReactNode } from 'react';

import { classNames } from './classNames.js';
import { TerminalButton } from './TerminalButton.js';
import {
  TERMINAL_DIALOG_BACKDROP_UTILITY,
  TERMINAL_DIALOG_DESCRIPTION_UTILITY,
  TERMINAL_DIALOG_FOOTER_UTILITY,
  TERMINAL_DIALOG_HEADER_UTILITY,
  TERMINAL_DIALOG_POPUP_UTILITY,
  TERMINAL_DIALOG_SIZE_UTILITY,
  TERMINAL_DRAWER_BACKDROP_UTILITY,
} from './terminalOverlayStyles.js';

export interface TerminalDialogProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly trigger?: ReactElement;
  readonly eyebrow?: string;
  readonly description?: string;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly closeLabel?: string;
}

export function TerminalDialog({
  title,
  children,
  trigger,
  eyebrow,
  description,
  footer,
  className,
  open,
  defaultOpen,
  onOpenChange,
  closeLabel = 'Закрыть',
}: TerminalDialogProps) {
  return (
    <Dialog.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}
    >
      {trigger ? <Dialog.Trigger render={trigger} /> : null}
      <Dialog.Portal>
        <Dialog.Backdrop
          className={classNames('terminal-dialog__backdrop', TERMINAL_DIALOG_BACKDROP_UTILITY)}
        />
        <Dialog.Viewport className="terminal-dialog__viewport fixed z-[calc(var(--z-dialog)_+_1)] inset-0 grid min-w-0 min-h-0 place-items-center p-hq-4">
          <Dialog.Popup
            className={classNames(
              'terminal-dialog',
              TERMINAL_DIALOG_POPUP_UTILITY,
              TERMINAL_DIALOG_SIZE_UTILITY,
              className,
            )}
          >
            <header
              className={classNames('terminal-dialog__header', TERMINAL_DIALOG_HEADER_UTILITY)}
            >
              <div className="terminal-dialog__heading">
                {eyebrow ? (
                  <span className="block m-0 text-hq-accent text-hq-xs tracking-[0.1em] uppercase">
                    {eyebrow}
                  </span>
                ) : null}
                <Dialog.Title className="block m-0 text-hq-md tracking-[0.06em] uppercase">
                  {title}
                </Dialog.Title>
              </div>
              <Dialog.Close
                aria-label={closeLabel}
                render={
                  <TerminalButton tone="quiet" size="small">
                    [ESC] CLOSE
                  </TerminalButton>
                }
              />
            </header>
            {description ? (
              <Dialog.Description
                className={classNames(
                  'terminal-dialog__description',
                  TERMINAL_DIALOG_DESCRIPTION_UTILITY,
                )}
              >
                {description}
              </Dialog.Description>
            ) : null}
            <div className="terminal-dialog__body min-w-0 min-h-0 overflow-auto p-hq-4">
              {children}
            </div>
            {footer ? (
              <footer
                className={classNames('terminal-dialog__footer', TERMINAL_DIALOG_FOOTER_UTILITY)}
              >
                {footer}
              </footer>
            ) : null}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface TerminalDrawerProps {
  readonly title: string;
  readonly eyebrow: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly closeLabel?: string;
}

export function TerminalDrawer({
  title,
  eyebrow,
  onClose,
  children,
  className,
  bodyClassName,
  closeLabel = 'Закрыть',
}: TerminalDrawerProps) {
  return (
    <Dialog.Root open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={classNames('terminal-drawer__backdrop', TERMINAL_DRAWER_BACKDROP_UTILITY)}
        />
        <Dialog.Popup
          render={<aside />}
          className={classNames('terminal-drawer', 'outline-none', className)}
        >
          <header>
            <div>
              <span>{eyebrow}</span>
              <Dialog.Title render={<strong />}>{title}</Dialog.Title>
            </div>
            <Dialog.Close
              aria-label={closeLabel}
              render={
                <TerminalButton tone="quiet" size="small">
                  [ESC] CLOSE
                </TerminalButton>
              }
            />
          </header>
          <div className={classNames('terminal-drawer__body', bodyClassName)}>{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
