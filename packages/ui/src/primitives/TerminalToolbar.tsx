'use client';

import { Toolbar } from '@base-ui/react/toolbar';

import { classNames } from './classNames.js';

export interface TerminalToolbarAction {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly tone?: 'neutral' | 'primary' | 'critical';
  readonly onPress: () => void;
}

export interface TerminalToolbarProps {
  readonly actions: ReadonlyArray<TerminalToolbarAction>;
  readonly label: string;
  readonly className?: string;
  readonly orientation?: 'horizontal' | 'vertical';
}

export function TerminalToolbar({
  actions,
  label,
  className,
  orientation = 'horizontal',
}: TerminalToolbarProps) {
  return (
    <Toolbar.Root
      aria-label={label}
      orientation={orientation}
      className={classNames('terminal-toolbar', className)}
    >
      {actions.map((action) => (
        <Toolbar.Button
          key={action.id}
          disabled={action.disabled}
          className="terminal-toolbar__button"
          data-tone={action.tone ?? 'neutral'}
          onClick={action.onPress}
        >
          <span>{action.label}</span>
          {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
        </Toolbar.Button>
      ))}
    </Toolbar.Root>
  );
}
