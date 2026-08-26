'use client';

import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

/**
 * Section id, catalogue id, badge.
 *
 * This is a second, shorter list than `application/navigation.ts`: it drives
 * `workspace.activeSection` rather than a route, and stops at nine. The labels
 * that used to be written out here are now ids, so the two lists can still
 * differ in what they contain without differing in what a section is called.
 */
const sections = [
  ['overview', 'nav.overview', '01'],
  ['objects', 'nav.objects', '02'],
  ['cases', 'nav.cases', '03'],
  ['map', 'nav.map', '04'],
  ['video', 'nav.video', '05'],
  ['comms', 'nav.comms', '06'],
  ['files', 'nav.files', '07'],
  ['archive', 'nav.archive', '08'],
  ['search', 'nav.search', '09'],
] as const satisfies readonly (readonly [string, MessageId, string])[];

export function NavigationRail() {
  const { controller } = useRuntime();
  const active = useAppStore((state) => state.workspace.activeSection);
  const t = useTranslate();
  return (
    <nav className="nav-rail" aria-label={t('nav.rail')}>
      {sections.map(([id, message, icon]) => {
        const label = t(message);
        return (
          <TerminalButton
            key={id}
            className={active === id ? 'is-active' : ''}
            onClick={() => controller?.setSection(id)}
            title={label}
          >
            <i aria-hidden="true">[{icon}]</i>
            <span>{label}</span>
          </TerminalButton>
        );
      })}
    </nav>
  );
}
