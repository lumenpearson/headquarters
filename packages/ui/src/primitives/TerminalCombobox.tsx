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
      <Combobox.InputGroup
        className={classNames(
          'terminal-combobox',
          'grid min-w-0 grid-cols-[minmax(0,1fr)_32px] border border-hq-line-1 bg-hq-bg-0 focus-within:border-hq-line-focus data-[popup-open]:border-hq-line-focus',
          className,
        )}
      >
        <Combobox.Input
          aria-label={label}
          placeholder={placeholder}
          className="terminal-combobox__input min-w-0 min-h-[34px] border-0 outline-none bg-transparent text-hq-text-0 font-mono text-hq-sm w-full px-hq-2"
        />
        <Combobox.Trigger
          aria-label={`Открыть список: ${label}`}
          className="terminal-combobox__trigger min-w-0 min-h-[34px] border-0 outline-none bg-transparent text-hq-text-0 font-mono text-hq-sm border-l border-l-hq-line-1 text-hq-accent cursor-pointer"
        >
          [⌄]
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          className="terminal-combobox__positioner z-[var(--z-popup)]"
        >
          <Combobox.Popup className="terminal-combobox__popup min-w-[var(--anchor-width)] max-w-[min(360px,calc(100vw_-_16px))] max-h-[min(320px,var(--available-height))] overflow-hidden border border-hq-line-2 outline-none bg-hq-bg-1 text-hq-text-1 text-[length:var(--ops-font-size,var(--font-xs))] tracking-[var(--ops-letter-spacing,normal)] leading-[var(--ops-line-height,1.4)] origin-[var(--transform-origin)] [transition:opacity_var(--motion-micro)_linear,transform_var(--motion-micro)_ease] data-[starting-style]:opacity-0 data-[starting-style]:scale-y-[0.94] data-[ending-style]:opacity-0 data-[ending-style]:scale-y-[0.94]">
            <Combobox.Empty className="terminal-combobox__empty p-hq-3 text-hq-text-2 font-mono text-hq-xs text-center">
              {emptyLabel}
            </Combobox.Empty>
            <Combobox.List className="terminal-combobox__list max-h-[inherit] overflow-auto p-[3px]">
              {options.map((option, index) => (
                <Combobox.Item
                  key={option.value}
                  value={option.value}
                  index={index}
                  disabled={option.disabled}
                  className="terminal-combobox__item grid min-h-[30px] grid-cols-[24px_minmax(0,1fr)] items-center px-hq-2 outline-none cursor-pointer font-mono text-[length:inherit] uppercase data-[highlighted]:bg-hq-accent data-[highlighted]:text-hq-text-inverse data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.38]"
                >
                  <Combobox.ItemIndicator className="terminal-combobox__indicator">
                    [×]
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 overflow-hidden whitespace-nowrap text-ellipsis">
                    {option.label}
                  </span>
                </Combobox.Item>
              ))}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
