'use client';

import { Tooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

import { classNames } from './classNames.js';

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
        <Tooltip.Positioner side={side} sideOffset={6} className="terminal-tooltip__positioner">
          <Tooltip.Popup role="tooltip" className={classNames('terminal-tooltip', className)}>
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
