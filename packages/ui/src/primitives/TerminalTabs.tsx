'use client';

import { Tabs } from '@base-ui/react/tabs';
import type { ReactNode } from 'react';

import { classNames } from './classNames.js';

export interface TerminalTab<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled?: boolean;
}

export interface TerminalTabsProps<Value extends string> {
  readonly value: Value;
  readonly tabs: ReadonlyArray<TerminalTab<Value>>;
  readonly onValueChange: (value: Value) => void;
  readonly label: string;
  readonly className?: string;
  readonly orientation?: 'horizontal' | 'vertical';
}

export function TerminalTabs<Value extends string>({
  value,
  tabs,
  onValueChange,
  label,
  className,
  orientation = 'horizontal',
}: TerminalTabsProps<Value>) {
  return (
    <Tabs.Root
      value={value}
      orientation={orientation}
      className={classNames(
        'terminal-tabs',
        'group grid min-w-0 min-h-0 grid-rows-[auto_minmax(0,1fr)] data-[orientation=vertical]:grid-rows-[minmax(0,1fr)] data-[orientation=vertical]:grid-cols-[auto_minmax(0,1fr)]',
        className,
      )}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      <Tabs.List
        aria-label={label}
        className="terminal-tabs__list relative flex min-w-0 border-b border-b-hq-line-1 group-data-[orientation=vertical]:flex-col group-data-[orientation=vertical]:border-r group-data-[orientation=vertical]:border-r-hq-line-1 group-data-[orientation=vertical]:border-b-0"
      >
        {tabs.map((tab) => (
          <Tabs.Tab
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className="terminal-tabs__tab border-0 min-h-[34px] px-hq-3 outline-none bg-transparent text-hq-text-2 cursor-pointer font-mono text-hq-xs uppercase"
          >
            {tab.label}
          </Tabs.Tab>
        ))}
        <Tabs.Indicator className="terminal-tabs__indicator absolute right-[var(--active-tab-right)] -bottom-px left-[var(--active-tab-left)] h-0.5 bg-hq-accent [transition:left_var(--motion-standard)_ease,right_var(--motion-standard)_ease]" />
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Panel
          key={tab.value}
          value={tab.value}
          className="terminal-tabs__panel min-w-0 min-h-0 outline-none p-hq-3"
        >
          {tab.content}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
