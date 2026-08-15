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
      className={classNames('terminal-tabs', className)}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      <Tabs.List aria-label={label} className="terminal-tabs__list">
        {tabs.map((tab) => (
          <Tabs.Tab
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className="terminal-tabs__tab"
          >
            {tab.label}
          </Tabs.Tab>
        ))}
        <Tabs.Indicator className="terminal-tabs__indicator" />
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Panel key={tab.value} value={tab.value} className="terminal-tabs__panel">
          {tab.content}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
