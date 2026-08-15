'use client';

import { useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { FilesScreen } from './FilesScreen';

export function ArchiveScreen() {
  const [period, setPeriod] = useState('30d');
  return (
    <div className="archive-screen">
      <div className="archive-timeline">
        <span>АРХИВНЫЙ ПЕРИОД</span>
        {['24h', '7d', '30d', '90d', 'year'].map((value) => (
          <TerminalButton
            key={value}
            className={period === value ? 'is-active' : ''}
            onClick={() => setPeriod(value)}
          >
            {value.toUpperCase()}
          </TerminalButton>
        ))}
        <i
          style={{
            width:
              period === '24h'
                ? '12%'
                : period === '7d'
                  ? '28%'
                  : period === '30d'
                    ? '51%'
                    : period === '90d'
                      ? '73%'
                      : '100%',
          }}
        />
      </div>
      <FilesScreen archive />
    </div>
  );
}
