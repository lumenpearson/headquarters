'use client';

import { ScrollArea } from '@base-ui/react/scroll-area';
import type { ReactNode } from 'react';

import { classNames } from './classNames.js';

export interface TerminalScrollAreaProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly viewportClassName?: string;
  readonly contentClassName?: string;
}

export function TerminalScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
}: TerminalScrollAreaProps) {
  return (
    <ScrollArea.Root className={classNames('terminal-scroll-area', className)}>
      <ScrollArea.Viewport
        className={classNames('terminal-scroll-area__viewport', viewportClassName)}
      >
        <ScrollArea.Content
          className={classNames('terminal-scroll-area__content', contentClassName)}
        >
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="terminal-scroll-area__scrollbar">
        <ScrollArea.Thumb className="terminal-scroll-area__thumb" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Corner className="terminal-scroll-area__corner" />
    </ScrollArea.Root>
  );
}
