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
    <ScrollArea.Root
      className={classNames(
        'terminal-scroll-area',
        'group relative min-w-0 min-h-0 overflow-hidden',
        className,
      )}
    >
      <ScrollArea.Viewport
        className={classNames(
          'terminal-scroll-area__viewport',
          'w-full h-full overscroll-contain',
          viewportClassName,
        )}
      >
        <ScrollArea.Content
          className={classNames('terminal-scroll-area__content', 'min-w-full', contentClassName)}
        >
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="terminal-scroll-area__scrollbar flex w-2 p-px bg-transparent opacity-0 transition-opacity duration-hq-micro ease-linear hover:opacity-100 group-data-[scrolling]:opacity-100">
        <ScrollArea.Thumb className="terminal-scroll-area__thumb w-full bg-hq-line-2" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Corner className="terminal-scroll-area__corner bg-hq-bg-0" />
    </ScrollArea.Root>
  );
}
