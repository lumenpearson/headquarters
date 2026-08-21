'use client';

import { useEffect, useState } from 'react';

import { useOperationsStore } from '../../state/operationsStore';
import { resolveStartupPlan, startupStages, type StartupStage } from './StartupPlan';

/**
 * R16: the terminal boot readout shown while the shell comes up.
 *
 * Mounted once per document, and it keeps no record of having run. That is the
 * requirement rather than an oversight: the sequence belongs to a process
 * start, so every launch of the desktop shell plays it, not only the first
 * one an operator ever sees. Writing "already seen" to localStorage or
 * sessionStorage would silence every launch after the first, and sessionStorage
 * would additionally survive a reload within the same tab.
 *
 * Client-side route changes do not remount the root layout, so moving between
 * screens does not replay it.
 */
export function StartupSequence() {
  const values = useOperationsStore((state) => state.personalization.draft.values);
  const plan = resolveStartupPlan({
    enabled: settingBoolean(values['startup.enabled'], true),
    animationsEnabled: settingBoolean(values['animations.enabled'], true),
    reducedMotion: settingBoolean(values['accessibility.reducedMotion'], false),
    intensity: settingNumber(values['animations.intensity'], 0.65),
  });

  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    if (!plan.play) return;
    const timer = window.setInterval(() => {
      setStageIndex((current) => current + 1);
    }, plan.stageMs);
    return () => window.clearInterval(timer);
  }, [plan.play, plan.stageMs]);

  const stage: StartupStage | undefined = startupStages[stageIndex];
  if (!plan.play || stage === undefined) return null;

  return (
    <div
      className="startup-sequence"
      data-stage={stage}
      role="presentation"
      aria-hidden="true"
      style={{ '--startup-stage-duration': `${plan.stageMs.toString()}ms` } as React.CSSProperties}
    >
      <div className="startup-sequence__readout">
        {startupStages.slice(0, stageIndex + 1).map((line) => (
          <p key={line} className="startup-sequence__line" data-line={line}>
            {startupLines[line]}
          </p>
        ))}
      </div>
    </div>
  );
}

const startupLines: Readonly<Record<StartupStage, string>> = {
  field: '> ИНИЦИАЛИЗАЦИЯ ПОЛЯ СИГНАЛА',
  panels: '> РАЗВЁРТЫВАНИЕ ПАНЕЛЕЙ ОПЕРАЦИИ',
  status: '> КАНАЛ СВЯЗИ: ЛОКАЛЬНЫЙ',
  ready: '> ШТАБ ГОТОВ',
};

function settingBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function settingNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
