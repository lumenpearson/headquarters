'use client';

import { Dialog } from '@base-ui/react/dialog';
import type { ReactElement, ReactNode } from 'react';

import { classNames } from './classNames.js';
import { TerminalButton } from './TerminalButton.js';

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
        <Dialog.Backdrop className="terminal-dialog__backdrop" />
        <Dialog.Viewport className="terminal-dialog__viewport">
          <Dialog.Popup className={classNames('terminal-dialog', className)}>
            <header className="terminal-dialog__header">
              <div className="terminal-dialog__heading">
                {eyebrow ? <span>{eyebrow}</span> : null}
                <Dialog.Title>{title}</Dialog.Title>
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
              <Dialog.Description className="terminal-dialog__description">
                {description}
              </Dialog.Description>
            ) : null}
            <div className="terminal-dialog__body">{children}</div>
            {footer ? <footer className="terminal-dialog__footer">{footer}</footer> : null}
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
        <Dialog.Backdrop className="terminal-drawer__backdrop" />
        <Dialog.Popup render={<aside />} className={classNames('terminal-drawer', className)}>
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
