'use client';

import { useState } from 'react';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import { RuntimeProvider, useRuntime } from '@/components/runtime/RuntimeProvider';
import { DeveloperPanel } from './DeveloperPanel';

export function DeveloperGate() {
  return (
    <RuntimeProvider>
      <GateContent />
    </RuntimeProvider>
  );
}

function GateContent() {
  const { controller, status } = useRuntime();
  const [code, setCode] = useState('');
  const [denied, setDenied] = useState(false);
  const submit = () => {
    if (controller === null) return;
    if (code !== controller.config.project.developerAccessCode) {
      setDenied(true);
      return;
    }
    setDenied(false);
    controller.toggleDeveloper();
  };
  return (
    <main className="dev-gate">
      <section>
        <i>DEV</i>
        <span>ИНЖЕНЕРНЫЙ КОНТУР / LOCAL ONLY</span>
        <h1>ДОСТУП ОГРАНИЧЕН</h1>
        <p>Введите локальный код проекта. Данные не отправляются в сеть.</p>
        <TerminalInput
          type="password"
          inputMode="numeric"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.code === 'Enter') submit();
          }}
          disabled={status !== 'ready'}
          aria-label="Код инженерного доступа"
          placeholder="••••••"
          autoFocus
        />
        <TerminalButton tone="primary" onClick={submit}>
          РАЗБЛОКИРОВАТЬ
        </TerminalButton>
        {denied ? <strong>КОД НЕ ПРИНЯТ</strong> : null}
        <small>Альтернативный вызов: Ctrl + Shift + Alt + D</small>
      </section>
      <DeveloperPanel />
    </main>
  );
}
