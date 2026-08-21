'use client';

import { Popover } from '@base-ui/react/popover';
import type { ReactElement, ReactNode } from 'react';

import { classNames } from './classNames.js';
import type { TerminalPopupSide } from './TerminalTooltip.js';

export interface TerminalPopoverProps {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly title?: string;
  readonly description?: string;
  readonly side?: TerminalPopupSide;
  readonly className?: string;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function TerminalPopover({
  trigger,
  children,
  title,
  description,
  side = 'bottom',
  className,
  open,
  defaultOpen,
  onOpenChange,
}: TerminalPopoverProps) {
  return (
    <Popover.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}
    >
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side={side} sideOffset={5} className="terminal-popover__positioner">
          <Popover.Popup className={classNames('terminal-popover', className)}>
            {title ? (
              <Popover.Title className="terminal-popover__title">{title}</Popover.Title>
            ) : null}
            {description ? (
              <Popover.Description className="terminal-popover__description">
                {description}
              </Popover.Description>
            ) : null}
            <div className="terminal-popover__body">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
