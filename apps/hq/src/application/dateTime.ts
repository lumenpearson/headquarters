'use client';

import { useSyncExternalStore } from 'react';

import { dateTimeFormat } from '@/application/localization/intl';
import { intlTag, t, useAppLocale } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
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
 * The locale is no longer a literal here.
 *
 * `dateTime.mode` chooses which clock is authoritative, not which language
 * names it, and until F11 the second question had no answer at all: the four
 * formatters below were built at import from `'ru-RU'`, so nothing could have
 * re-read `localization.locale` even once it had a reader. They now come from
 * `localization/intl.ts`, which caches per locale tag -- the tick still costs
 * one map lookup rather than a constructor, and a locale change misses the
 * cache and builds what the new locale needs.
 *
 * Two worklists, and they are no longer the same list.
 *
 * **The locale.** `TopBar`, `VirtualExplorer`, `DeveloperPanel`,
 * `SettingsScreen`'s history stamps and the tables and feeds on the cases,
 * files, objects, overview, reports and search screens now take their
 * formatter from `localization/intl.ts` like this module does.
 * `OperationsShell`'s `formatDateTime` and snapshot button,
 * `CommunicationsScreen`'s event feed and `SystemScreen`'s log followed in
 * F11's chrome-translation pass, closing the last live `'ru-RU'` literals
 * inside this app. Two live outside it and cannot read a client setting at
 * all -- `packages/domain/src/explorerTree.ts` is framework-free by design
 * and `apps/file-bridge/src/BridgeService.ts` is a separate process.
 *
 * **The mode.** Only the shell clock in `OpsTopBar` and the stamp in
 * `OpsStatusLine` follow `dateTime.mode`. Every stamp named above still shows
 * the machine's own clock whatever the operator chose, which is a separate
 * defect from the locale and is not closed by F11.
 */

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

/** `dateTime.showSeconds` off. */
const { second: _second, ...minuteParts } = timeParts;

const utcParts = { ...timeParts, timeZone: 'UTC' } as const;
const utcMinuteParts = { ...minuteParts, timeZone: 'UTC' } as const;

const modeLabels: Readonly<Record<DateTimeMode, MessageId>> = {
  operation: 'clock.mode.operation',
  system: 'clock.mode.system',
  // Not `clock.mode.utc`: UTC is the name of a time scale, the same three
  // letters in every language, so it lives in the catalogue's non-translatable
  // namespace rather than being translated into something no one looks for.
  utc: 'token.utc',
};

/** The marker that says which clock the shell is showing. */
export function dateTimeModeLabel(mode: DateTimeMode): string {
  return t(modeLabels[mode]);
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
 *
 * The formatter it takes belongs to whichever locale is in force at the moment
 * of the call, so this is no longer a function of its arguments alone. That is
 * deliberate and is what makes the shell clock follow `localization.locale`;
 * a caller that must pin a reading formats the instant itself.
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
  if (mode === 'system') return dateTimeFormat(showSeconds ? timeParts : minuteParts).format(now);
  if (mode === 'utc') return dateTimeFormat(showSeconds ? utcParts : utcMinuteParts).format(now);
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
 *
 * The locale is subscribed to as well, and not because the reading would
 * otherwise be stale for long -- a clock re-renders every second anyway. It is
 * subscribed because `dateTimeModeLabel` beside it does not tick, and a marker
 * still reading `СИСТ` next to a clock the operator has just switched to
 * English is the kind of half-applied change that makes a setting look broken.
 */
export function useShellClock(): string {
  const mode = useDateTimeMode();
  const showSeconds = useBooleanSetting('dateTime.showSeconds');
  useAppLocale();
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

/**
 * The topbar's `ДАТА` reading: the calendar date, not the operation's own
 * clock. `dateTime.mode` picks which clock names the time of day, but there is
 * no fictional calendar behind it, only a fictional time of day -- `system`
 * and `utc` both read the machine's date for the same reason they read its
 * time, and `operation` has no date of its own to offer instead.
 */
export function formatShellDate(now: Date): string {
  const day = dateTimeFormat({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
  const weekday = dateTimeFormat({ weekday: 'short' }).format(now).toLocaleUpperCase(intlTag());
  return `${day} / ${weekday}`;
}

/** `formatShellDate`, ticking and following the locale, the way `useShellClock` does. */
export function useShellDate(): string {
  useAppLocale();
  useSyncExternalStore(subscribeToTick, tickSnapshot, serverTickSnapshot);
  return formatShellDate(new Date());
}
