'use client';

import {
  TerminalButton,
  TerminalInput,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';

import { Panel } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

export function SettingsScreen() {
  const state = useOperationsStore((value) => value);
  return (
    <div className="ops-screen settings-screen">
      <header className="ops-screen__title">
        <div>
          <span>LOCAL CONFIGURATION / PERSISTED</span>
          <h1>НАСТРОЙКИ КОНТУРА</h1>
        </div>
        <span className="settings-saved">[✓] ИЗМЕНЕНИЯ СОХРАНЯЮТСЯ ЛОКАЛЬНО</span>
      </header>
      <div className="settings-layout">
        <Panel title="ИНТЕРФЕЙС" eyebrow="DISPLAY / TERMINAL" className="settings-interface">
          <Setting label="КОМПАКТНАЯ НАВИГАЦИЯ" detail="Освобождает пространство рабочей области">
            <TerminalSwitch
              label="Компактная навигация"
              className="settings-toggle"
              checked={state.ui.navCompact}
              onCheckedChange={() => state.toggleNavCompact()}
            />
          </Setting>
          <Setting label="АНИМАЦИИ" detail="Плавные переходы и импульсы событий">
            <TerminalSwitch
              label="Анимации"
              className="settings-toggle"
              checked={state.production.animations}
              onCheckedChange={(value) => state.setProductionOption('animations', value)}
            />
          </Setting>
          <Setting label="CAMERA SAFE" detail="Снижает контраст и яркость для съёмки">
            <TerminalSwitch
              label="Camera safe"
              className="settings-toggle"
              checked={state.production.cameraSafe}
              onCheckedChange={(value) => state.setProductionOption('cameraSafe', value)}
            />
          </Setting>
          <Setting label="CURSOR MODE" detail="Поведение курсора в полноэкранном режиме">
            <TerminalSelect
              label="Cursor mode"
              value={state.production.cursorMode}
              onValueChange={(value) => state.setProductionOption('cursorMode', value)}
              options={[
                { value: 'visible', label: 'VISIBLE' },
                { value: 'auto', label: 'AUTO HIDE' },
                { value: 'hidden', label: 'HIDDEN' },
              ]}
            />
          </Setting>
        </Panel>
        <Panel title="СИМУЛЯЦИЯ" eyebrow="DETERMINISTIC WORLD" className="settings-simulation">
          <Setting label="СОСТОЯНИЕ" detail={`TICK ${state.metrics.simulationStep}`}>
            <TerminalSwitch
              label="Состояние симуляции"
              className="settings-toggle"
              checked={!state.production.paused}
              onCheckedChange={(value) => state.setProductionOption('paused', !value)}
            />
          </Setting>
          <Setting label="СКОРОСТЬ ЧАСОВ" detail="Масштаб локального времени">
            <TerminalSelect
              label="Скорость часов"
              value={String(state.production.clockSpeed) as '0.5' | '1' | '2' | '5'}
              onValueChange={(value) =>
                state.setProductionOption('clockSpeed', Number(value) as 0.5 | 1 | 2 | 5)
              }
              options={[
                { value: '0.5', label: '0.5×' },
                { value: '1', label: '1×' },
                { value: '2', label: '2×' },
                { value: '5', label: '5×' },
              ]}
            />
          </Setting>
          <Setting label="РЕЖИМ ЧАСОВ" detail="Фиксированное или системное время">
            <TerminalSelect
              label="Режим часов"
              value={state.production.clockMode}
              onValueChange={(value) => state.setProductionOption('clockMode', value)}
              options={[
                { value: 'fixed', label: 'FIXED' },
                { value: 'real', label: 'SYSTEM REAL' },
              ]}
            />
          </Setting>
          <Setting label="ФИКСИРОВАННОЕ ВРЕМЯ" detail="HH:MM:SS">
            <TerminalInput
              aria-label="Фиксированное время"
              value={state.production.fixedTime}
              onValueChange={(value) => state.setProductionOption('fixedTime', value)}
            />
          </Setting>
        </Panel>
        <Panel title="РАБОЧЕЕ МЕСТО" eyebrow="MULTI MONITOR" className="settings-monitor">
          <Setting label="SCREEN ID" detail="Идентификатор текущего монитора">
            <TerminalSelect
              label="Screen ID"
              value={state.production.screenId}
              onValueChange={(value) => state.setProductionOption('screenId', value)}
              options={['MON-01', 'MON-02', 'MON-03', 'MON-04', 'MON-05', 'MON-06'].map((id) => ({
                value: id,
                label: id,
              }))}
            />
          </Setting>
          <Setting label="AUTO DEMO" detail="Циклическое локальное демо, отключается при вводе">
            <TerminalSwitch
              label="Auto demo"
              className="settings-toggle"
              checked={state.production.autoDemo}
              onCheckedChange={(value) => state.setProductionOption('autoDemo', value)}
            />
          </Setting>
          <TerminalButton className="ops-action" onClick={() => state.toggleProductionPanel(true)}>
            [CTRL+SHIFT+P] PRODUCTION PANEL
          </TerminalButton>
          <TerminalButton
            className="ops-action"
            onClick={() =>
              document.fullscreenElement === null
                ? void document.documentElement.requestFullscreen()
                : void document.exitFullscreen()
            }
          >
            [F] FULLSCREEN / KIOSK
          </TerminalButton>
        </Panel>
        <Panel title="ЛОКАЛЬНЫЕ ДАННЫЕ" eyebrow="PERSISTENCE / OFFLINE" className="settings-data">
          <p>
            Конфигурация, подтверждения тревог, выполненные задачи и съёмочные snapshots хранятся в
            профиле браузера. Сеть не требуется.
          </p>
          <dl className="ops-definition-list">
            <div>
              <dt>WORLD STORE</dt>
              <dd>ZUSTAND / NORMALIZED</dd>
            </div>
            <div>
              <dt>PERSISTENCE</dt>
              <dd>LOCALSTORAGE V2</dd>
            </div>
            <div>
              <dt>SYNC</dt>
              <dd>BROADCASTCHANNEL</dd>
            </div>
            <div>
              <dt>EXPORT</dt>
              <dd>STATIC / OFFLINE</dd>
            </div>
          </dl>
          <TerminalButton
            className="ops-action ops-action--danger"
            tone="critical"
            onClick={() => state.resetWorld()}
          >
            [R] СБРОСИТЬ ОПЕРАТИВНЫЙ МИР
          </TerminalButton>
        </Panel>
        <Panel title="ГОРЯЧИЕ КЛАВИШИ" eyebrow="KEYMAP / TERMINAL" className="settings-keymap">
          {[
            ['1–9', 'ПЕРЕХОД ПО РАЗДЕЛАМ'],
            ['CTRL+K', 'ГЛОБАЛЬНЫЙ ПОИСК'],
            ['CTRL+SHIFT+P', 'PRODUCTION PANEL'],
            ['F', 'FULLSCREEN'],
            ['SPACE', 'PLAY / PAUSE VIDEO'],
            ['ESC', 'ЗАКРЫТЬ DRAWER / PANEL'],
          ].map(([key, label]) => (
            <div key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

function Setting({
  label,
  detail,
  children,
}: {
  readonly label: string;
  readonly detail: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {children}
    </div>
  );
}
