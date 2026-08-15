import type { ReactNode } from 'react';

export interface StatusBadgeProperties {
  readonly tone: 'ok' | 'warning' | 'critical' | 'neutral';
  readonly children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProperties) {
  return <span className={`hq-status hq-status--${tone}`}>{children}</span>;
}
