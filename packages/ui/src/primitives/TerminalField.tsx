'use client';

import { Field } from '@base-ui/react/field';
import type { ReactNode } from 'react';

import { classNames } from './classNames.js';

export interface TerminalFieldProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly description?: string;
  readonly error?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly name?: string;
}

export function TerminalField({
  label,
  children,
  description,
  error,
  className,
  disabled = false,
  invalid = Boolean(error),
  name,
}: TerminalFieldProps) {
  return (
    <Field.Root
      disabled={disabled}
      invalid={invalid}
      name={name}
      className={classNames('terminal-field', className)}
    >
      <Field.Label className="terminal-field__label">{label}</Field.Label>
      {description ? (
        <Field.Description className="terminal-field__description">{description}</Field.Description>
      ) : null}
      {children}
      {error ? <Field.Error className="terminal-field__error">{error}</Field.Error> : null}
    </Field.Root>
  );
}
