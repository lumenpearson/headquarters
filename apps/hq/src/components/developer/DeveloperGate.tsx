'use client';

import { useState } from 'react';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import { useAppLocale, t } from '@/application/localization/locale';
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
  // Neither `controller` nor `status` carries the locale; without this the
  // gate would render whichever language was in force when it first mounted.
  useAppLocale();
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
        <i>{t('developer.badge')}</i>
        <span>
          {t('developer.panelHeading')} / {t('developer.localOnlyLabel')}
        </span>
        <h1>{t('developer.accessRestrictedHeading')}</h1>
        <p>{t('developer.enterCodeInstruction')}</p>
        <TerminalInput
          type="password"
          inputMode="numeric"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.code === 'Enter') submit();
          }}
          disabled={status !== 'ready'}
          aria-label={t('developer.accessCodeAriaLabel')}
          placeholder="••••••"
          autoFocus
        />
        <TerminalButton tone="primary" onClick={submit}>
          {t('developer.unlockButton')}
        </TerminalButton>
        {denied ? <strong>{t('developer.codeRejectedNotice')}</strong> : null}
        <small>{t('developer.alternativeShortcutNote')}</small>
      </section>
      <DeveloperPanel />
    </main>
  );
}
