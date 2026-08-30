'use client';

import { useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import { FilesScreen } from './FilesScreen';

const periods = ['24h', '7d', '30d', '90d', 'year'] as const;

export function ArchiveScreen() {
  const translate = useTranslate();
  const [period, setPeriod] = useState<(typeof periods)[number]>('30d');
  return (
    <div className="archive-screen">
      <div className="archive-timeline">
        <span>{translate('archive.periodLabel')}</span>
        {periods.map((value) => (
          <TerminalButton
            key={value}
            className={period === value ? 'is-active' : ''}
            onClick={() => setPeriod(value)}
          >
            {value === 'year' ? translate('archive.periodYear') : value.toUpperCase()}
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
