'use client';

import type { OpsSeverity, OpsStatus } from '@gremuchaya/domain';
import { TerminalDrawer, TerminalTooltip } from '@gremuchaya/ui/primitives';
import type { ReactElement, ReactNode } from 'react';
import { useStringSetting } from '@/application/personalization/useSetting';
import { ContentEditor } from '@/components/edit/ContentEditor';
import { TileCaptionProvider, useElementCaption } from '@/components/layout/tileCaption';

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
  /*
   * R28's second half, where an operator can see it: the caption they wrote for
   * this tile in the language now in force, or the one the application ships.
   * The address comes from `TileGrid` through `TileCaptionProvider`; a panel
   * drawn outside a tile grid has no address and keeps its own title.
   *
   * `data-panel` deliberately keeps the shipped title. It is how a stylesheet
   * and a test name this panel, and an identity that changed when the operator
   * renamed a heading would be an identity in the operator's gift.
   */
  const caption = useElementCaption(title);
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
          <h2>{caption}</h2>
        </div>
        {actions}
      </header>
      {/*
       * The scope ends at this heading. A panel nested in the body draws its
       * own heading, and letting it inherit would rename every panel inside a
       * renamed tile along with it.
       */}
      <div className="ops-panel__body">
        <TileCaptionProvider scope={null}>{children}</TileCaptionProvider>
      </div>
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

/** The band of the 38-unit viewBox a series is drawn in, floor first. */
const sparklineFloor = 34;
const sparklineCeiling = 2;

export function Sparkline({
  values,
  label,
  domain,
}: {
  readonly values: readonly number[];
  readonly label: string;
  /**
   * The range the plot's height spans, low bound first.
   *
   * Every series used to be divided by three and clipped to `[2, 102]`, so a
   * caller with megabytes per second had to scale it by hand at the call site
   * and anything past the ceiling flattened into one line at the top without
   * saying so. A series states its own range instead; without one the plot
   * takes the extremes of the values it was handed, which cannot clip because
   * they are the data.
   */
  readonly domain?: readonly [number, number];
}) {
  const readings = values.filter((value) => Number.isFinite(value));
  const lowest = domain?.[0] ?? Math.min(...readings);
  const highest = domain?.[1] ?? Math.max(...readings);
  const span = highest - lowest;
  const level = (value: number): number =>
    // A flat series and a zero-width domain both sit mid-plot: there is no
    // shape to draw, and pinning them to the floor would read as a collapse.
    span > 0 ? (Math.min(Math.max(value, lowest), highest) - lowest) / span : 0.5;
  const height = (value: number): number =>
    sparklineFloor - level(value) * (sparklineFloor - sparklineCeiling);
  // One reading is a flat line across the plot rather than a single vertex,
  // which `polyline` draws as nothing at all.
  const points =
    readings.length === 1
      ? [0, 100].map((x) => `${x},${height(readings[0] ?? 0)}`).join(' ')
      : readings
          .map((value, index) => `${(index / (readings.length - 1)) * 100},${height(value)}`)
          .join(' ');
  return (
    <svg
      className="ops-sparkline"
      viewBox="0 0 100 38"
      preserveAspectRatio="none"
      aria-label={label}
    >
      <path d="M0 12H100M0 25H100" />
      {readings.length === 0 ? null : <polyline points={points} />}
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

/**
 * A record card, over the screen and modal while it is open.
 *
 * The content editor is mounted inside it, after the card's own content, so
 * that the fields the card carries can be edited from where they are. The card
 * traps focus and hides the rest of the document from assistive technology --
 * that is what a modal dialog is -- which left the editor in the floating
 * panel visible, selectable and unreachable (R4). Last rather than first: the
 * editor appears the moment a value is selected, and inserting it above the
 * card's body would move the value the operator had just pointed at.
 *
 * It draws nothing outside edit mode and nothing while no value is selected,
 * so a card that carries no editable value is the card it always was.
 */
export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
  variant = 'aside',
}: {
  readonly title: string;
  readonly eyebrow: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /**
   * 'aside' is the right-anchored slide-over every record kind has always
   * used; 'card' is the centred, width-capped surface the file record opts
   * into (t4-file-dialog-card) via the `ops-drawer--card` modifier in
   * operations.css. Byte-for-byte unchanged for every other kind, which never
   * passes this prop.
   */
  readonly variant?: 'aside' | 'card';
}) {
  const drawerWidth = useStringSetting('popups.drawerWidth');
  const drawerScrim = useStringSetting('popups.drawerScrim');
  return (
    <TerminalDrawer
      title={title}
      eyebrow={eyebrow}
      onClose={onClose}
      className={`ops-drawer ${variant === 'card' ? 'ops-drawer--card' : ''} ${
        drawerWidth === 'standard' ? '' : `ops-drawer--${drawerWidth}`
      } ${drawerScrim === 'standard' ? '' : `ops-drawer--scrim-${drawerScrim}`}`.trim()}
      bodyClassName="ops-drawer__body"
    >
      {children}
      <ContentEditor host="drawer" />
    </TerminalDrawer>
  );
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <div className="ops-empty">[ {children} ]</div>;
}
