'use client';

import { useSyncExternalStore } from 'react';

import { useBooleanSetting, useStringSetting } from '@/application/personalization/useSetting';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

/**
 * The clocks `dateTime.mode` chooses between.
 *
 * The names are the ones `packages/settings-schema` declares for the setting.
 * They are repeated here because the definition exposes only a validator, and
 * `dateTime.test.ts` asserts every name below is one the definition accepts.
 */
export const dateTimeModes = ['operation', 'system', 'utc'] as const;

export type DateTimeMode = (typeof dateTimeModes)[number];

/*
 * The locale is a literal here, deliberately.
 *
 * `dateTime.mode` chooses which clock is authoritative, not which language
 * names it; `localization.locale` is a separate definition that no locale
 * runtime reads yet, and F11 owns it. This module is the address F11 routes
 * the rest through.
 *
 * Routed through here today: the shell clock in `OpsTopBar` and the time stamp
 * in `OpsStatusLine`. Still holding their own `ru-RU` literal and therefore
 * still ignoring the mode: `components/shell/TopBar`, `VirtualExplorer`,
 * `DeveloperPanel`'s rehearsal and snapshot stamps, `SettingsScreen`'s history
 * stamps, `OperationsShell`'s own `formatDateTime` and snapshot button, and
 * the tables and event feeds on the cases, files, objects, overview, reports,
 * communications, search and system screens. F11 owns all of them.
 */
const locale = 'ru-RU';

/**
 * `hourCycle: 'h23'` rather than `hour12: false`: the latter still lets an
 * implementation print midnight as `24:00`, which on a shoot sheet reads as
 * tomorrow.
 */
const timeParts = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
} as const;

const systemTime = new Intl.DateTimeFormat(locale, timeParts);
const utcTime = new Intl.DateTimeFormat(locale, { ...timeParts, timeZone: 'UTC' });

/*
 * `dateTime.showSeconds` off, hoisted rather than constructed per tick: this
 * runs once a second for the life of the session, and building a formatter
 * inside the tick is the cost this module already avoids for the other two.
 */
const { second: _second, ...minuteParts } = timeParts;
const systemMinutes = new Intl.DateTimeFormat(locale, minuteParts);
const utcMinutes = new Intl.DateTimeFormat(locale, { ...minuteParts, timeZone: 'UTC' });

const modeLabels: Readonly<Record<DateTimeMode, string>> = {
  operation: 'ОПЕР',
  system: 'СИСТ',
  utc: 'UTC',
};

/** The marker that says which clock the shell is showing. */
export function dateTimeModeLabel(mode: DateTimeMode): string {
  return modeLabels[mode];
}

/**
 * Narrows a stored value to a mode.
 *
 * Not a second copy of the default: the readers in
 * `personalization/useSetting` have already resolved the definition's own
 * default and rejected anything it would not accept, so a value reaching here
 * is always one of the three. The branch exists for the compiler, and
 * `dateTime.test.ts` asserts it lands on the definition's default so the
 * literal cannot drift from the schema.
 */
export function resolveDateTimeMode(value: string): DateTimeMode {
  return dateTimeModes.find((mode) => mode === value) ?? 'operation';
}

/** Seconds since midnight, which is all a wall clock shows. */
export function formatSecondsOfDay(seconds: number, showSeconds = true): string {
  const wrapped = ((seconds % 86_400) + 86_400) % 86_400;
  const parts = [Math.floor(wrapped / 3600), Math.floor((wrapped % 3600) / 60)];
  if (showSeconds) parts.push(Math.floor(wrapped % 60));
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

/**
 * Where the operation clock stands.
 *
 * The production panel drives it: `fixed` starts from the time the director
 * set and advances by the elapsed operation-seconds, `real` means the director
 * pinned the operation to the machine's own clock. This is the reading
 * `operation` mode shows, and the one `system` and `utc` deliberately ignore.
 */
export function operationSecondsOfDay(
  production: { readonly clockMode: 'real' | 'fixed'; readonly fixedTime: string },
  elapsed: number,
  now: Date,
): number {
  if (production.clockMode === 'real') {
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  }
  const parts = production.fixedTime.split(':').map(Number);
  return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) + elapsed;
}

/**
 * The clock the shell prints, for the mode the operator chose.
 *
 * `system` and `utc` read the machine, which is the point of the setting's
 * description: the operator sees the real time without the OS clock being
 * touched and without the operation's own time being moved.
 */
export function formatShellClock(
  mode: DateTimeMode,
  {
    now,
    operationSeconds,
    showSeconds = true,
  }: {
    readonly now: Date;
    readonly operationSeconds: number;
    /** `dateTime.showSeconds`. One argument reaches all three modes. */
    readonly showSeconds?: boolean;
  },
): string {
  if (mode === 'system') return (showSeconds ? systemTime : systemMinutes).format(now);
  if (mode === 'utc') return (showSeconds ? utcTime : utcMinutes).format(now);
  return formatSecondsOfDay(operationSeconds, showSeconds);
}

/*
 * One second, published once.
 *
 * The header clock and the status line show the same instant. Two intervals
 * started from two components would advance the operation clock twice per
 * second and let the two readings differ by a second at every boundary, so the
 * tick -- and the operation-seconds it accumulates -- lives beside the
 * formatter and is shared, in the same subscriber-table idiom the keybind
 * runtime already uses.
 */
let operationElapsed = 0;
let tick = 0;
let intervalId = 0;
const tickListeners = new Set<() => void>();

function subscribeToTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (intervalId === 0) {
    intervalId = window.setInterval(() => {
      // A frozen production stops the operation clock. The machine clock and
      // UTC do not stop with it, so the tick itself keeps running and only the
      // accumulator pauses.
      const { production } = operationsStore.getState();
      if (!production.paused) operationElapsed += production.clockSpeed;
      tick += 1;
      for (const listen of [...tickListeners]) listen();
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0) {
      window.clearInterval(intervalId);
      intervalId = 0;
    }
  };
}

function tickSnapshot(): number {
  return tick;
}

/** No interval on the server, so the first paint is the operation's own start. */
function serverTickSnapshot(): number {
  return 0;
}

export function useDateTimeMode(): DateTimeMode {
  return resolveDateTimeMode(useStringSetting('dateTime.mode'));
}

/**
 * The shell clock, ticking, in whichever mode is selected.
 *
 * Subscribing to the shared tick is what re-renders the caller each second;
 * the reading itself is computed here so both callers cannot disagree about
 * it.
 */
export function useShellClock(): string {
  const mode = useDateTimeMode();
  const showSeconds = useBooleanSetting('dateTime.showSeconds');
  const clockMode = useOperationsStore((state) => state.production.clockMode);
  const fixedTime = useOperationsStore((state) => state.production.fixedTime);
  useSyncExternalStore(subscribeToTick, tickSnapshot, serverTickSnapshot);
  const now = new Date();
  return formatShellClock(mode, {
    now,
    operationSeconds: operationSecondsOfDay({ clockMode, fixedTime }, operationElapsed, now),
    showSeconds,
  });
}
