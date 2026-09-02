'use client';

import { useEffect, useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { dateTimeFormat } from '@/application/localization/intl';
import { useAppLocale } from '@/application/localization/locale';
import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

export function TopBar() {
  const { controller, status } = useRuntime();
  const locale = useAppLocale();
  const fixedTime = useAppStore((state) => state.operator.fixedTime);
  const clockMode = useAppStore((state) => state.operator.clockMode);
  const sceneId = useAppStore((state) => state.scene.activeSceneId);
  const preload = useAppStore((state) => state.scene.preload);
  const screensById = useAppStore((state) => state.screens.byId);
  const [clock, setClock] = useState(fixedTime);

  // FREEZE and BLACKOUT are one-way from this bar by shoot-day rule (see
  // docs/release/runbook.md: "обратной кнопки нет, единственный выход — RESET"),
  // so the buttons stay in place and instead reflect whether either state is
  // currently active anywhere in the scene, rather than offering a toggle.
  const screenStates = Object.values(screensById);
  const isFrozen = screenStates.some((screen) => screen.frozen);
  const isBlackedOut = screenStates.some((screen) => screen.blackout);

  useEffect(() => {
    if (clockMode !== 'real') return;
    const update = () =>
      setClock(
        dateTimeFormat({
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      );
    update();
    const intervalId = window.setInterval(update, 1000);
    return () => window.clearInterval(intervalId);
    // `locale` is a dependency and not decoration: the reading is written into
    // component state by the interval, so without a re-subscription the clock
    // would keep the format it was started with until the mode changed.
  }, [clockMode, fixedTime, locale]);

  return (
    <header className="topbar">
      <div className="brand">
        <i aria-hidden="true">ГС</i>
        <div>
          <strong>ОПЕРАТИВНЫЙ ШТАБ</strong>
          <span>TTY://HQ/CONTROL</span>
        </div>
      </div>
      <div className="topbar__scene">
        <span>SCENE:</span>
        <strong>{sceneId ?? 'НЕ ВЫБРАНА'}</strong>
        <small>
          {preload.total === 0 ? 'LOCAL/IDLE' : `BUF ${preload.ready}/${preload.total}`}
        </small>
      </div>
      <div className="topbar__right">
        <span className={`system-state system-state--${status}`}>
          {status === 'ready' ? 'READY' : status === 'failed' ? 'CONFIG ERR' : 'BOOT'}
        </span>
        <TerminalButton
          tone="quiet"
          className={isFrozen ? 'quiet-button is-active' : 'quiet-button'}
          aria-pressed={isFrozen}
          title={isFrozen ? 'FREEZE активен — выход через RESET' : undefined}
          onClick={() => controller?.sceneService.applyFreeze(true)}
        >
          FREEZE
        </TerminalButton>
        <TerminalButton
          tone="critical"
          className={isBlackedOut ? 'danger-button is-active' : 'danger-button'}
          aria-pressed={isBlackedOut}
          title={isBlackedOut ? 'BLACKOUT активен — выход через RESET' : undefined}
          onClick={() => controller?.sceneService.applyEmergencyBlackout(true)}
        >
          BLACKOUT
        </TerminalButton>
        <time>{clockMode === 'real' ? clock : fixedTime}</time>
      </div>
    </header>
  );
}
