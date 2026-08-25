'use client';

import type { OpsSeverity, OpsStatus } from '@gremuchaya/domain';
import { TerminalDrawer, TerminalTooltip } from '@gremuchaya/ui/primitives';
import type { ReactElement, ReactNode } from 'react';
import { useStringSetting } from '@/application/personalization/useSetting';

const statusLabels: Readonly<Record<OpsStatus, string>> = {
  ACTIVE: 'АКТИВЕН',
  READY: 'ГОТОВ',
  NORMAL: 'НОРМА',
  SECURED: 'ЗАЩИЩЕН',
  IN_PROGRESS: 'В РАБОТЕ',
  WAITING: 'ОЖИДАЕТ',
  RESERVE: 'РЕЗЕРВ',
  WATCHED: 'ПОД НАБЛЮДЕНИЕМ',
  RESTRICTED: 'ОГРАНИЧЕН',
  SIGNAL_LOST: 'ПОТЕРЯ СИГНАЛА',
  ALERT: 'ТРЕВОГА',
  CRITICAL: 'КРИТИЧЕСКИЙ',
  NEUTRALIZED: 'НЕЙТРАЛИЗОВАН',
  ARCHIVED: 'АРХИВ',
};

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className = '',
  onClick,
}: {
  readonly title: string;
  readonly eyebrow?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly onClick?: () => void;
}) {
  const Element = onClick === undefined ? 'section' : 'button';
  return (
    <Element
      className={`ops-panel ${onClick === undefined ? '' : 'ops-panel--clickable'} ${className}`}
      data-panel={title}
      onClick={onClick}
    >
      <i className="ops-panel__corners" aria-hidden="true" />
      <header className="ops-panel__header">
        <div>
          {eyebrow === undefined ? null : <span>{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {actions}
      </header>
      <div className="ops-panel__body">{children}</div>
    </Element>
  );
}

export function StatusBadge({ status }: { readonly status: OpsStatus }) {
  const tone =
    status === 'CRITICAL' || status === 'SIGNAL_LOST' || status === 'ALERT'
      ? 'critical'
      : status === 'WAITING' || status === 'WATCHED' || status === 'RESTRICTED'
        ? 'warning'
        : status === 'ACTIVE' || status === 'READY' || status === 'NORMAL' || status === 'SECURED'
          ? 'ok'
          : 'neutral';
  return <span className={`ops-status ops-status--${tone}`}>[{statusLabels[status]}]</span>;
}

export function SeverityBadge({ severity }: { readonly severity: OpsSeverity }) {
  const label =
    severity === 'critical'
      ? 'КРИТИЧЕСКИЙ'
      : severity === 'warning'
        ? 'ПРЕДУПРЕЖДЕНИЕ'
        : severity === 'normal'
          ? 'НОРМА'
          : 'ИНФО';
  return <span className={`ops-severity ops-severity--${severity}`}>[{label}]</span>;
}

export function Metric({
  label,
  value,
  detail,
  tone = 'normal',
  onClick,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly detail?: string;
  readonly tone?: 'normal' | 'ok' | 'warning' | 'critical';
  readonly onClick?: () => void;
}) {
  const Element = onClick === undefined ? 'div' : 'button';
  return (
    <Element className={`ops-metric ops-metric--${tone}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail === undefined ? null : <small>{detail}</small>}
    </Element>
  );
}

export function ProgressBar({
  value,
  label,
  tone = 'normal',
}: {
  readonly value: number;
  readonly label?: string;
  readonly tone?: 'normal' | 'ok' | 'warning' | 'critical';
}) {
  const normalized = Math.min(100, Math.max(0, value));
  return (
    <div
      className={`ops-progress ops-progress--${tone}`}
      aria-label={label ?? `Прогресс ${normalized}%`}
    >
      <i style={{ width: `${normalized}%` }} />
      <span>{label}</span>
      <b>{Math.round(normalized)}%</b>
    </div>
  );
}

export function Gauge({
  value,
  label,
  detail,
}: {
  readonly value: number;
  readonly label: string;
  readonly detail?: string;
}) {
  const normalized = Math.min(100, Math.max(0, value));
  const dash = normalized * 1.57;
  return (
    <div className="ops-gauge" aria-label={`${label}: ${normalized}%`}>
      <svg viewBox="0 0 200 112" aria-hidden="true">
        <path d="M20 100A80 80 0 0 1 180 100" />
        <path
          className="ops-gauge__value"
          d="M20 100A80 80 0 0 1 180 100"
          style={{ strokeDasharray: `${dash} 157` }}
        />
        {[0, 1, 2, 3, 4].map((tick) => (
          <line key={tick} x1={20 + tick * 40} y1="100" x2={20 + tick * 40} y2="94" />
        ))}
      </svg>
      <strong>{Math.round(normalized)}%</strong>
      <span>{label}</span>
      {detail === undefined ? null : <small>{detail}</small>}
    </div>
  );
}

export function Sparkline({
  values,
  label,
}: {
  readonly values: readonly number[];
  readonly label: string;
}) {
  const points = values
    .map(
      (value, index) =>
        `${(index / Math.max(1, values.length - 1)) * 100},${36 - Math.min(34, Math.max(2, value / 3))}`,
    )
    .join(' ');
  return (
    <svg
      className="ops-sparkline"
      viewBox="0 0 100 38"
      preserveAspectRatio="none"
      aria-label={label}
    >
      <path d="M0 12H100M0 25H100" />
      <polyline points={points} />
    </svg>
  );
}

export function Tooltip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}) {
  return <TerminalTooltip label={label}>{children}</TerminalTooltip>;
}

export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
}: {
  readonly title: string;
  readonly eyebrow: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const drawerWidth = useStringSetting('popups.drawerWidth');
  const drawerScrim = useStringSetting('popups.drawerScrim');
  return (
    <TerminalDrawer
      title={title}
      eyebrow={eyebrow}
      onClose={onClose}
      className={`ops-drawer ${drawerWidth === 'standard' ? '' : `ops-drawer--${drawerWidth}`} ${
        drawerScrim === 'standard' ? '' : `ops-drawer--scrim-${drawerScrim}`
      }`.trim()}
      bodyClassName="ops-drawer__body"
    >
      {children}
    </TerminalDrawer>
  );
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <div className="ops-empty">[ {children} ]</div>;
}
