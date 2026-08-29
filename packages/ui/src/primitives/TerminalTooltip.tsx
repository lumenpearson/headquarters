'use client';

import { Tooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

import { classNames } from './classNames.js';
import { TERMINAL_POPUP_POSITIONER_UTILITY } from './terminalOverlayStyles.js';

export type TerminalPopupSide = 'top' | 'right' | 'bottom' | 'left';

export interface TerminalTooltipProps {
  readonly label: ReactNode;
  readonly children: ReactElement;
  readonly side?: TerminalPopupSide;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function TerminalTooltip({
  label,
  children,
  side = 'top',
  className,
  disabled = false,
}: TerminalTooltipProps) {
  return (
    <Tooltip.Root disabled={disabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner
          side={side}
          sideOffset={6}
          className={classNames('terminal-tooltip__positioner', TERMINAL_POPUP_POSITIONER_UTILITY)}
        >
          <Tooltip.Popup
            role="tooltip"
            className={classNames(
              'terminal-tooltip',
              'max-w-[min(280px,calc(100vw_-_16px))] py-[5px] px-[7px] border border-hq-accent bg-hq-bg-1 text-hq-text-0 [font-family:var(--font-mono)] text-[length:var(--ops-font-size,var(--font-xs))] leading-[1.35] transition-[opacity,transform] duration-hq-micro [transition-timing-function:linear,ease] data-[starting-style]:opacity-0 data-[starting-style]:translate-y-[2px] data-[ending-style]:opacity-0 data-[ending-style]:translate-y-[2px]',
              className,
            )}
          >
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
