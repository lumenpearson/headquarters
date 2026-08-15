import type { ReactNode } from 'react';

export interface PanelProperties {
  readonly title: string;
  readonly eyebrow?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Panel({ title, eyebrow, action, children, className }: PanelProperties) {
  const classNames = ['hq-panel', className].filter(Boolean).join(' ');

  return (
    <section className={classNames}>
      <header className="hq-panel__header">
        <div>
          {eyebrow === undefined ? null : <span className="hq-panel__eyebrow">{eyebrow}</span>}
          <h2 className="hq-panel__title">{title}</h2>
        </div>
        {action}
      </header>
      <div className="hq-panel__body">{children}</div>
    </section>
  );
}
