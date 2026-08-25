// @vitest-environment jsdom
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import {
  dateTimeModeLabel,
  dateTimeModes,
  formatSecondsOfDay,
  formatShellClock,
  operationSecondsOfDay,
  resolveDateTimeMode,
  useShellClock,
} from './dateTime';

const definition = getSettingDefinition('dateTime.mode');

/** 2026-09-12, 21:05:07 UTC -- an instant whose UTC reading is unambiguous. */
const instant = new Date(Date.UTC(2026, 8, 12, 21, 5, 7));

const pad = (value: number): string => String(value).padStart(2, '0');

const localReading = (date: Date): string =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

function chooseMode(mode: string): void {
  operationsStore.getState().applySettingsPatch([{ id: 'dateTime.mode', value: mode }]);
}

function ShellClockProbe() {
  return <output>{useShellClock()}</output>;
}

describe('dateTime.mode', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('offers exactly the modes the definition accepts', () => {
    for (const mode of dateTimeModes) {
      expect(definition?.validate(mode), mode).toBe(true);
    }
    expect(definition?.validate('shoot-local')).toBe(false);
  });

  it('narrows an unusable value to the definition’s own default', () => {
    expect(resolveDateTimeMode('shoot-local')).toBe(definition?.defaultValue);
  });

  it('shows the operation clock, the machine clock and UTC as three readings', () => {
    const operationSeconds = 7 * 3600 + 42 * 60 + 15;

    // The operation's own time: what the production panel drives, and what no
    // change of machine timezone can move.
    expect(formatShellClock('operation', { now: instant, operationSeconds })).toBe('07:42:15');
    // The machine's local time, without the OS clock being touched.
    expect(formatShellClock('system', { now: instant, operationSeconds })).toBe(
      localReading(instant),
    );
    expect(formatShellClock('utc', { now: instant, operationSeconds })).toBe('21:05:07');
  });

  it('advances the operation clock by the elapsed seconds and wraps at midnight', () => {
    expect(
      formatSecondsOfDay(
        operationSecondsOfDay({ clockMode: 'fixed', fixedTime: '07:42:15' }, 45, instant),
      ),
    ).toBe('07:43:00');
    expect(
      formatSecondsOfDay(
        operationSecondsOfDay({ clockMode: 'fixed', fixedTime: '23:59:50' }, 20, instant),
      ),
    ).toBe('00:00:10');
  });

  it('follows the machine when the director pinned the operation to real time', () => {
    // `clockMode: 'real'` is the production panel's own decision, and
    // `operation` mode reports it rather than overriding it.
    expect(
      formatSecondsOfDay(
        operationSecondsOfDay({ clockMode: 'real', fixedTime: '07:42:15' }, 900, instant),
      ),
    ).toBe(localReading(instant));
  });

  it('names the clock it is showing', () => {
    expect(dateTimeModeLabel('operation')).toBe('ОПЕР');
    expect(dateTimeModeLabel('system')).toBe('СИСТ');
    expect(dateTimeModeLabel('utc')).toBe('UTC');
  });

  it('drives the shell clock from the setting rather than from the production slice alone', () => {
    // The default: the operation's own start time, which the seed pins.
    const operation = render(<ShellClockProbe />);
    expect(screen.getByRole('status').textContent).toBe('07:42:15');
    operation.unmount();

    chooseMode('utc');
    const before = new Date();
    render(<ShellClockProbe />);
    const after = new Date();
    // A second can turn over between the render and the assertion, so either
    // reading is correct; what must not happen is the operation's 07:42:15.
    expect([
      formatShellClock('utc', { now: before, operationSeconds: 0 }),
      formatShellClock('utc', { now: after, operationSeconds: 0 }),
    ]).toContain(screen.getByRole('status').textContent);
  });
});
