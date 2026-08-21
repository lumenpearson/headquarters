import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { TerminalUiProvider } from '@gremuchaya/ui/primitives';

import { ContextMenuRuntime } from '@/components/contextMenus/ContextMenuRuntime';
import { EditModeFrame } from '@/components/edit/EditModeFrame';
import { EditModeRuntime } from '@/components/edit/EditModeRuntime';
import { EditPanel } from '@/components/edit/EditPanel';
import { KeybindIntro } from '@/components/keybinds/KeybindIntro';
import { KeybindRuntime } from '@/components/keybinds/KeybindRuntime';
import { MaterialCatalogProvider } from '@/components/settings/MaterialCatalog';
import { StartupSequence } from '@/components/startup/StartupSequence';
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
          <MaterialCatalogProvider>
            <KeybindRuntime />
            <ContextMenuRuntime />
            <EditModeRuntime />
            <KeybindIntro />
            <StartupSequence />
            <EditModeFrame />
            <OperationsRuntime>{children}</OperationsRuntime>
            <EditPanel />
          </MaterialCatalogProvider>
        </TerminalUiProvider>
      </body>
    </html>
  );
}
