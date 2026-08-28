'use client';

import { Combobox } from '@base-ui/react/combobox';

import { classNames } from './classNames.js';

export interface TerminalComboboxOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface TerminalComboboxProps<Value extends string> {
  readonly value: Value | null;
  readonly options: ReadonlyArray<TerminalComboboxOption<Value>>;
  readonly onValueChange: (value: Value | null) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
}

export function TerminalCombobox<Value extends string>({
  value,
  options,
  onValueChange,
  label,
  className,
  disabled = false,
  placeholder = '[SEARCH / SELECT]',
  emptyLabel = '[ НЕТ СОВПАДЕНИЙ ]',
}: TerminalComboboxProps<Value>) {
  const values = options.map((option) => option.value);

  return (
    <Combobox.Root
      value={value}
      items={values}
      disabled={disabled}
      autoHighlight
      itemToStringLabel={(itemValue) =>
        options.find((option) => option.value === itemValue)?.label ?? itemValue
      }
      onValueChange={(nextValue) => onValueChange(nextValue)}
    >
      <Combobox.InputGroup className={classNames('terminal-combobox', className)}>
        <Combobox.Input
          aria-label={label}
          placeholder={placeholder}
          className="terminal-combobox__input"
        />
        <Combobox.Trigger
          aria-label={`Открыть список: ${label}`}
          className="terminal-combobox__trigger"
        >
          [⌄]
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          className="terminal-combobox__positioner"
        >
          <Combobox.Popup className="terminal-combobox__popup">
            <Combobox.Empty className="terminal-combobox__empty">{emptyLabel}</Combobox.Empty>
            <Combobox.List className="terminal-combobox__list">
              {options.map((option, index) => (
                <Combobox.Item
                  key={option.value}
                  value={option.value}
                  index={index}
                  disabled={option.disabled}
                  className="terminal-combobox__item"
                >
                  <Combobox.ItemIndicator className="terminal-combobox__indicator">
                    [×]
                  </Combobox.ItemIndicator>
                  <span>{option.label}</span>
                </Combobox.Item>
              ))}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
