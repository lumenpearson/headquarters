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
      <Select.Trigger
        aria-label={label}
        className={classNames(
          'terminal-select',
          'grid min-h-[34px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-hq-2 px-hq-2 border border-hq-line-1 outline-none bg-hq-bg-0 text-hq-text-0 cursor-pointer font-mono text-hq-sm text-left',
          className,
        )}
      >
        <Select.Value>
          {(selectedValue: Value | null) =>
            options.find((option) => option.value === selectedValue)?.label ?? placeholder
          }
        </Select.Value>
        <Select.Icon className="terminal-select__icon text-hq-accent">[⌄]</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
          className="terminal-select__positioner z-[var(--z-popup)]"
        >
          <Select.Popup className="terminal-select__popup min-w-[var(--anchor-width)] max-w-[min(360px,calc(100vw_-_16px))] max-h-[min(320px,var(--available-height))] overflow-hidden border border-hq-line-2 outline-none bg-hq-bg-1 text-hq-text-1 text-[length:var(--ops-font-size,var(--font-xs))] tracking-[var(--ops-letter-spacing,normal)] leading-[var(--ops-line-height,1.4)] origin-[var(--transform-origin)] [transition:opacity_var(--motion-micro)_linear,transform_var(--motion-micro)_ease] data-[starting-style]:opacity-0 data-[starting-style]:scale-y-[0.94] data-[ending-style]:opacity-0 data-[ending-style]:scale-y-[0.94]">
            <Select.List className="terminal-select__list max-h-[inherit] overflow-auto p-[3px]">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  // The option's stored value, published to the DOM beside
                  // its label. The label is translated and the trigger's
                  // accessible name is the label, so anything that picked an
                  // option by the words in it was picking in one language;
                  // the value is the same in every locale.
                  data-option-value={option.value}
                  disabled={option.disabled}
                  className="terminal-select__item grid min-h-[30px] grid-cols-[24px_minmax(0,1fr)] items-center px-hq-2 outline-none cursor-pointer font-mono text-[length:inherit] uppercase data-[highlighted]:bg-hq-accent data-[highlighted]:text-hq-text-inverse data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.38]"
                >
                  <Select.ItemIndicator className="terminal-select__indicator text-current">
                    [×]
                  </Select.ItemIndicator>
                  <Select.ItemText className="col-start-2 overflow-hidden whitespace-nowrap text-ellipsis">
                    {option.label}
                  </Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
