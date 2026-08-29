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
  /*
   * `.terminal-toolbar` is Toolbar.Root's plain `<div role="toolbar">` and
   * migrates in full. `.terminal-toolbar__button` shares its primitives.css
   * rule with `.terminal-toggle` (TerminalToggle.tsx carries the matching
   * utilities): chrome and the `[data-pressed]`/`:focus-visible` overrides
   * stay in css there, and the `[data-tone='critical']` colour stays here for
   * the same reason -- the attribute selector already outranks `.ops-shell
   * button`. The `kbd` shortcut's own styling is uncontested (`body.terminal-
   * theme` only reaches its `font-family`, not the rest of the `font: inherit`
   * shorthand this rule sets, nor its colour or opacity) and migrates in full.
   */
  return (
    <Toolbar.Root
      aria-label={label}
      orientation={orientation}
      className={classNames(
        'terminal-toolbar',
        'flex min-w-0 gap-[2px] data-[orientation=vertical]:flex-col',
        className,
      )}
    >
      {actions.map((action) => (
        <Toolbar.Button
          key={action.id}
          disabled={action.disabled}
          className="terminal-toolbar__button inline-flex items-center justify-between gap-hq-3 min-h-[30px] px-hq-2 uppercase cursor-pointer"
          data-tone={action.tone ?? 'neutral'}
          onClick={action.onPress}
        >
          <span>{action.label}</span>
          {action.shortcut ? (
            <kbd className="text-current [font:inherit] opacity-70">{action.shortcut}</kbd>
          ) : null}
        </Toolbar.Button>
      ))}
    </Toolbar.Root>
  );
}
