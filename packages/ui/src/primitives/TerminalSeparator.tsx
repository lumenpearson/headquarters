'use client';

import { Separator } from '@base-ui/react/separator';

import { classNames } from './classNames.js';

export interface TerminalSeparatorProps {
  readonly className?: string;
  readonly orientation?: 'horizontal' | 'vertical';
}

export function TerminalSeparator({
  className,
  orientation = 'horizontal',
}: TerminalSeparatorProps) {
  return (
    <Separator orientation={orientation} className={classNames('terminal-separator', className)} />
  );
}
