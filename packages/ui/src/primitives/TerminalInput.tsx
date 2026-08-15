'use client';

import { Input } from '@base-ui/react/input';
import { forwardRef } from 'react';
import type { InputProps } from '@base-ui/react/input';

import { classNames } from './classNames.js';

export interface TerminalInputProps extends Omit<InputProps, 'className'> {
  readonly className?: string;
}

export const TerminalInput = forwardRef<HTMLElement, TerminalInputProps>(function TerminalInput(
  { className, ...properties },
  reference,
) {
  return (
    <Input
      {...properties}
      ref={reference}
      className={classNames('hq-input', 'terminal-input', className)}
    />
  );
});
