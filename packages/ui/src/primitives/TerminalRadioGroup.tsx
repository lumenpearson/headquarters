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
  return (
    <RadioGroup
      value={value}
      disabled={disabled}
      aria-label={label}
      className={classNames('terminal-radio-group', className)}
      onValueChange={(nextValue) => onValueChange(nextValue)}
    >
      {options.map((option) => (
        <div key={option.value} className="terminal-radio-option">
          <Radio.Root
            nativeButton
            render={<button type="button" />}
            value={option.value}
            disabled={option.disabled}
            aria-label={option.label}
            className="terminal-radio"
          >
            <Radio.Indicator className="terminal-radio__indicator" />
          </Radio.Root>
          <span>{option.label}</span>
        </div>
      ))}
    </RadioGroup>
  );
}
