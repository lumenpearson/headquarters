'use client';

import { useEffect, useState } from 'react';

import { booleanSetting, numberSetting } from '../../application/personalization/settingValue';
import { revealWindow } from '../../infrastructure/tauri/revealWindow';
import { useOperationsStore } from '../../state/operationsStore';
import { resolveStartupPlan, startupStages, type StartupStage } from './StartupPlan';
import { useDocumentLoaded } from './useDocumentLoaded';

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
 * The readout does not advance until the document has fully loaded, and the
 * hidden desktop window is shown only after that load has been painted: an
 * operator therefore never watches the sequence run against a page that is
 * still fetching its own resources, and never sees the window before there is
 * anything to see in it. The reveal is not gated on the sequence playing --
 * an operator who switched the sequence off still needs a window.
 *
 * Client-side route changes do not remount the root layout, so moving between
 * screens does not replay it.
 */
export function StartupSequence() {
  const values = useOperationsStore((state) => state.personalization.draft.values);
  const plan = resolveStartupPlan({
    enabled: booleanSetting(values, 'startup.enabled'),
    animationsEnabled: booleanSetting(values, 'animations.enabled'),
    reducedMotion: booleanSetting(values, 'accessibility.reducedMotion'),
    intensity: numberSetting(values, 'animations.intensity'),
    stageHold: numberSetting(values, 'startup.stageHold'),
  });

  const loaded = useDocumentLoaded();
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    if (!loaded) return;
    // Two frames: the first schedules against the current paint, the second
    // runs after the overlay (or the shell) has actually been drawn, so the
    // window never appears mid-frame with nothing on it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void revealWindow();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [loaded]);

  useEffect(() => {
    if (!plan.play || !loaded) return;
    const timer = window.setInterval(() => {
      setStageIndex((current) => current + 1);
    }, plan.stageMs);
    return () => window.clearInterval(timer);
  }, [plan.play, plan.stageMs, loaded]);

  const stage: StartupStage | undefined = startupStages[stageIndex];
  if (!plan.play || stage === undefined) return null;

  return (
    <div
      className="startup-sequence"
      data-stage={stage}
      role="presentation"
      aria-hidden="true"
      style={
        {
          '--startup-stage-duration': `${plan.stageMs.toString()}ms`,
          '--startup-total-duration': `${plan.totalMs.toString()}ms`,
        } as React.CSSProperties
      }
    >
      <div className="startup-sequence__readout">
        {startupStages.slice(0, stageIndex + 1).map((line) => (
          <p key={line} className="startup-sequence__line" data-line={line}>
            {startupLines[line]}
          </p>
        ))}
        <div className="startup-sequence__progress" />
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
