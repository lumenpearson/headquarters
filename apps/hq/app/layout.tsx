import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { TerminalUiProvider } from '@gremuchaya/ui/primitives';

import { OperationsRuntime } from '@/simulation/OperationsRuntime';

import '@gremuchaya/ui/styles/tokens.css';
import '@gremuchaya/ui/styles/primitives.css';
import './globals.css';

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
