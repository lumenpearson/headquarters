'use client';

import { useEffect, useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

export function TopBar() {
  const { controller, status } = useRuntime();
  const fixedTime = useAppStore((state) => state.operator.fixedTime);
  const clockMode = useAppStore((state) => state.operator.clockMode);
  const sceneId = useAppStore((state) => state.scene.activeSceneId);
  const preload = useAppStore((state) => state.scene.preload);
  const [clock, setClock] = useState(fixedTime);

  useEffect(() => {
    if (clockMode !== 'real') return;
    const update = () =>
      setClock(
        new Intl.DateTimeFormat('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(new Date()),
      );
    update();
    const intervalId = window.setInterval(update, 1000);
    return () => window.clearInterval(intervalId);
  }, [clockMode, fixedTime]);

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
          className="quiet-button"
          onClick={() => controller?.sceneService.applyFreeze(true)}
        >
          FREEZE
        </TerminalButton>
        <TerminalButton
          tone="critical"
          className="danger-button"
          onClick={() => controller?.sceneService.applyEmergencyBlackout(true)}
        >
          BLACKOUT
        </TerminalButton>
        <time>{clockMode === 'real' ? clock : fixedTime}</time>
      </div>
    </header>
  );
}
