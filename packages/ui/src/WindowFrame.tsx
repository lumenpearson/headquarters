import type { ReactNode } from 'react';

export interface WindowFrameProperties {
  readonly title: string;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function WindowFrame({ title, meta, children, className }: WindowFrameProperties) {
  const classNames = ['hq-window', className].filter(Boolean).join(' ');
  return (
    <section className={classNames}>
      <header className="hq-window__chrome">
        <span className="hq-window__title">{title}</span>
        {meta}
      </header>
      <div className="hq-window__body">{children}</div>
    </section>
  );
}
