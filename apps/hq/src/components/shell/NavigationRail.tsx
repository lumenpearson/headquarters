'use client';

import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

const sections = [
  ['overview', 'ОБЗОР', '01'],
  ['objects', 'ОБЪЕКТЫ', '02'],
  ['cases', 'ДЕЛА', '03'],
  ['map', 'КАРТА', '04'],
  ['video', 'ВИДЕО', '05'],
  ['comms', 'СВЯЗЬ', '06'],
  ['files', 'ФАЙЛЫ', '07'],
  ['archive', 'АРХИВ', '08'],
  ['search', 'ПОИСК', '09'],
] as const;

export function NavigationRail() {
  const { controller } = useRuntime();
  const active = useAppStore((state) => state.workspace.activeSection);
  return (
    <nav className="nav-rail" aria-label="Разделы штаба">
      {sections.map(([id, label, icon]) => (
        <TerminalButton
          key={id}
          className={active === id ? 'is-active' : ''}
          onClick={() => controller?.setSection(id)}
          title={label}
        >
          <i aria-hidden="true">[{icon}]</i>
          <span>{label}</span>
        </TerminalButton>
      ))}
    </nav>
  );
}
