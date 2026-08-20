import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { TerminalUiProvider } from '@gremuchaya/ui/primitives';

import { OperationsRuntime } from '@/simulation/OperationsRuntime';

import '@gremuchaya/ui/styles/tokens.css';
import '@gremuchaya/ui/styles/primitives.css';
import './globals.css';

/*
 * The shadcn preset wires Geist through `next/font/google` and points
 * `--font-mono` at it. That is deliberately not adopted here: the terminal type
 * stacks in tokens.css are part of the product's look, and `next/font/google`
 * fetches at build time, which conflicts with the offline-first desktop target.
 * Typography stays owned by tokens.css.
 */

export const metadata: Metadata = {
  title: 'Гремучая смесь — Оперативный штаб',
  description: 'Локальная съёмочная система оперативного штаба',
};

interface RootLayoutProperties {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProperties) {
  return (
    <html lang="ru">
      <body className="terminal-theme">
        <TerminalUiProvider>
          <OperationsRuntime>{children}</OperationsRuntime>
        </TerminalUiProvider>
      </body>
    </html>
  );
}
