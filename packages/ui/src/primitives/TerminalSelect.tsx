'use client';

import { Select } from '@base-ui/react/select';

import { classNames } from './classNames.js';

export interface TerminalSelectOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface TerminalSelectProps<Value extends string> {
  readonly value: Value;
  readonly options: ReadonlyArray<TerminalSelectOption<Value>>;
  readonly onValueChange: (value: Value) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

export function TerminalSelect<Value extends string>({
  value,
  options,
  onValueChange,
  label,
  className,
  disabled = false,
  placeholder = '[SELECT]',
}: TerminalSelectProps<Value>) {
  return (
    <Select.Root
      value={value}
      disabled={disabled}
      items={options}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onValueChange(nextValue);
      }}
    >
      <Select.Trigger aria-label={label} className={classNames('terminal-select', className)}>
        <Select.Value>
          {(selectedValue: Value | null) =>
            options.find((option) => option.value === selectedValue)?.label ?? placeholder
          }
        </Select.Value>
        <Select.Icon className="terminal-select__icon">[⌄]</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="bottom"
          sideOffset={4}
          alignItemWithTrigger={false}
          className="terminal-select__positioner"
        >
          <Select.Popup className="terminal-select__popup">
            <Select.List className="terminal-select__list">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="terminal-select__item"
                >
                  <Select.ItemIndicator className="terminal-select__indicator">
                    [×]
                  </Select.ItemIndicator>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
