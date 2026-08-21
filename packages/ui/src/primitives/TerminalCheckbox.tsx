'use client';

import { Checkbox } from '@base-ui/react/checkbox';

import { classNames } from './classNames.js';

export interface TerminalCheckboxProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly indeterminate?: boolean;
}

export function TerminalCheckbox({
  checked,
  onCheckedChange,
  label,
  className,
  disabled = false,
  indeterminate = false,
}: TerminalCheckboxProps) {
  return (
    <Checkbox.Root
      nativeButton
      render={<button type="button" />}
      checked={checked}
      disabled={disabled}
      indeterminate={indeterminate}
      aria-label={label}
      className={classNames('terminal-checkbox', className)}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
    >
      <Checkbox.Indicator className="terminal-checkbox__indicator">
        {indeterminate ? '[−]' : '[×]'}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
