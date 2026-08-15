'use client';

import { Toast } from '@base-ui/react/toast';
import { Tooltip } from '@base-ui/react/tooltip';
import type { ReactNode } from 'react';

import { TerminalToastViewport } from './TerminalToast.js';

export interface TerminalUiProviderProps {
  readonly children: ReactNode;
}

export function TerminalUiProvider({ children }: TerminalUiProviderProps) {
  return (
    <Tooltip.Provider delay={450} closeDelay={50} timeout={300}>
      <Toast.Provider timeout={5000} limit={4}>
        {children}
        <TerminalToastViewport />
      </Toast.Provider>
    </Tooltip.Provider>
  );
}
