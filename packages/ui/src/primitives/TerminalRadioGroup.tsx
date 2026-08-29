'use client';

import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';

import { classNames } from './classNames.js';

export interface TerminalRadioOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface TerminalRadioGroupProps<Value extends string> {
  readonly value: Value;
  readonly options: ReadonlyArray<TerminalRadioOption<Value>>;
  readonly onValueChange: (value: Value) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function TerminalRadioGroup<Value extends string>({
  value,
  options,
  onValueChange,
  label,
  className,
  disabled = false,
}: TerminalRadioGroupProps<Value>) {
  /*
   * `.terminal-radio-group` and `.terminal-radio-option` render as plain
   * `<div>`s, which no app stylesheet's element reset or `.ops-shell`/
   * `body.terminal-theme` rule reaches, so both migrate in full. `.terminal-
   * radio` is a real `<button>`: its chrome and the `[data-checked]`/
   * `:focus-visible` border-color stay in primitives.css for the same reason
   * as TerminalCheckbox's; its shape and size, which nothing contests, move
   * here, as does `.terminal-radio__indicator`'s dot (a plain `<span>`).
   */
  return (
    <RadioGroup
      value={value}
      disabled={disabled}
      aria-label={label}
      className={classNames('terminal-radio-group', 'flex min-w-0 flex-wrap gap-hq-2', className)}
      onValueChange={(nextValue) => onValueChange(nextValue)}
    >
      {options.map((option) => (
        <div
          key={option.value}
          className="terminal-radio-option inline-flex min-h-[28px] items-center gap-hq-2 text-hq-text-1 cursor-pointer [font-family:var(--font-mono)] text-hq-xs uppercase"
        >
          <Radio.Root
            nativeButton
            render={<button type="button" />}
            value={option.value}
            disabled={option.disabled}
            aria-label={option.label}
            className="terminal-radio grid place-items-center size-5"
          >
            <Radio.Indicator className="terminal-radio__indicator size-2 bg-hq-accent" />
          </Radio.Root>
          <span>{option.label}</span>
        </div>
      ))}
    </RadioGroup>
  );
}
