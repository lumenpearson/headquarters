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
  /*
   * `.terminal-field`, `__label`, `__description` and `__error` render as
   * `<div>`/`<label>`/`<p>`, none of which any app stylesheet's element reset
   * or `.ops-shell`/`body.terminal-theme` rule reaches, so nothing here is
   * contested and the whole block moves to utilities.
   */
  return (
    <Field.Root
      disabled={disabled}
      invalid={invalid}
      name={name}
      className={classNames('terminal-field', 'grid min-w-0 gap-hq-1', className)}
    >
      <Field.Label className="terminal-field__label text-hq-text-0 [font-family:var(--font-mono)] text-hq-xs font-bold tracking-[0.06em] uppercase">
        {label}
      </Field.Label>
      {description ? (
        <Field.Description className="terminal-field__description text-hq-text-2 [font-family:var(--font-mono)] text-hq-xs">
          {description}
        </Field.Description>
      ) : null}
      {children}
      {error ? (
        <Field.Error className="terminal-field__error text-hq-critical [font-family:var(--font-mono)] text-hq-xs">
          {error}
        </Field.Error>
      ) : null}
    </Field.Root>
  );
}
