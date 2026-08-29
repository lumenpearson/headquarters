'use client';

import { Separator } from '@base-ui/react/separator';

import { classNames } from './classNames.js';

export interface TerminalSeparatorProps {
  readonly className?: string;
  readonly orientation?: 'horizontal' | 'vertical';
}

/*
 * Base UI's `Separator` renders a plain `<div role="separator">`, which no
 * app stylesheet's element reset or `.ops-shell`/`body.terminal-theme` rule
 * reaches, so the whole rule -- the line colour and both orientations' sizing
 * -- migrates in full.
 */
export function TerminalSeparator({
  className,
  orientation = 'horizontal',
}: TerminalSeparatorProps) {
  return (
    <Separator
      orientation={orientation}
      className={classNames(
        'terminal-separator',
        'flex-none bg-hq-line-1 data-[orientation=horizontal]:w-full data-[orientation=horizontal]:h-px data-[orientation=vertical]:w-px data-[orientation=vertical]:h-full',
        className,
      )}
    />
  );
}
