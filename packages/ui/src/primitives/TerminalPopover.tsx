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
        <Popover.Positioner
          side={side}
          sideOffset={5}
          className="terminal-popover__positioner z-[var(--z-popup)]"
        >
          <Popover.Popup
            className={classNames(
              'terminal-popover',
              'min-w-[220px] max-w-[min(420px,calc(100vw_-_16px))] border border-hq-line-2 outline-none bg-hq-bg-1 text-hq-text-0 origin-[var(--transform-origin)] transition-[opacity,transform] duration-hq-micro [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:scale-y-[0.94] data-[ending-style]:opacity-0 data-[ending-style]:scale-y-[0.94]',
              className,
            )}
          >
            {title ? (
              <Popover.Title className="terminal-popover__title block m-0 px-hq-3 py-hq-2 border-b border-hq-line-1 text-hq-accent-strong text-hq-sm uppercase">
                {title}
              </Popover.Title>
            ) : null}
            {description ? (
              <Popover.Description className="terminal-popover__description block m-0 px-hq-3 py-hq-2 text-hq-text-2 [font-family:var(--font-mono)] text-[length:var(--ops-font-size,var(--font-xs))]">
                {description}
              </Popover.Description>
            ) : null}
            <div className="terminal-popover__body p-hq-3">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
