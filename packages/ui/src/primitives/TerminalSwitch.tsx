'use client';

import { Switch } from '@base-ui/react/switch';

import { classNames } from './classNames.js';

export interface TerminalSwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onLabel?: string;
  readonly offLabel?: string;
}

export function TerminalSwitch({
  checked,
  onCheckedChange,
  label,
  className,
  disabled = false,
  onLabel = '[ON]',
  offLabel = '[OFF]',
}: TerminalSwitchProps) {
  return (
    <Switch.Root
      nativeButton
      render={<button type="button" />}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      className={classNames('terminal-switch', checked && 'is-active', className)}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
    >
      <span className="terminal-switch__label">{checked ? onLabel : offLabel}</span>
      <Switch.Thumb className="terminal-switch__thumb" />
    </Switch.Root>
  );
}
