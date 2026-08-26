// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyWindowCorners,
  parseHostWindowProfile,
  readHostWindowProfile,
  webHostWindowProfile,
} from './hostWindowProfile';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

function mockNativeShell(handler: (command: string, args: unknown) => unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  Object.assign(globalThis, { isTauri: true });
  mockIPC((command, args) => {
    calls.push({ command, args });
    return handler(command, args);
  });
  return calls;
}

/** The payloads `classify` produces in `host_profile.rs`, family for family. */
const win11 = { family: 'win11', buildNumber: 22631, rounded: true };
const win10 = { family: 'win10', buildNumber: 19045, rounded: false };
const legacy = { family: 'legacy', buildNumber: 9600, rounded: false };
const other = { family: 'other', buildNumber: null, rounded: false };

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('readHostWindowProfile', () => {
  it('reads the family, the build and the corner treatment the native side classified', async () => {
    const calls = mockNativeShell((command) =>
      command === 'host_window_profile' ? win11 : undefined,
    );

    await expect(readHostWindowProfile()).resolves.toEqual(win11);
    expect(calls).toEqual([{ command: 'host_window_profile', args: {} }]);
  });

  it('carries each of the four families through unchanged', async () => {
    for (const profile of [win11, win10, legacy, other]) {
      clearMocks();
      mockNativeShell((command) => (command === 'host_window_profile' ? profile : undefined));

      await expect(readHostWindowProfile()).resolves.toEqual(profile);
    }
  });

  it('answers `other` in a web session without reaching the IPC bridge', async () => {
    // The absence is the claim: a browser has no kernel build to classify, and
    // a guess from the user agent would ask DWM for corners on a window it does
    // not own.
    const calls = mockNativeShell(() => win11);
    Reflect.deleteProperty(globalThis, 'isTauri');

    await expect(readHostWindowProfile()).resolves.toEqual(webHostWindowProfile);
    expect(calls).toEqual([]);
  });
});

describe('applyWindowCorners', () => {
  it('asks for round corners and for square ones by the same command', async () => {
    const calls = mockNativeShell(() => null);

    await applyWindowCorners(true);
    await applyWindowCorners(false);

    expect(calls).toEqual([
      { command: 'apply_window_corners', args: { rounded: true } },
      { command: 'apply_window_corners', args: { rounded: false } },
    ]);
  });

  it('invokes nothing in a web session', async () => {
    const calls = mockNativeShell(() => null);
    Reflect.deleteProperty(globalThis, 'isTauri');

    await applyWindowCorners(true);

    expect(calls).toEqual([]);
  });

  it('reports the native rejection rather than swallowing it', async () => {
    mockNativeShell(() => {
      throw 'DwmSetWindowAttribute failed: HRESULT 0x80070057';
    });

    await expect(applyWindowCorners(true)).rejects.toBe(
      'DwmSetWindowAttribute failed: HRESULT 0x80070057',
    );
  });
});

describe('parseHostWindowProfile', () => {
  it('reads an absent build number as never-reported rather than as a build', () => {
    expect(parseHostWindowProfile({ family: 'other', rounded: false })).toEqual(other);
  });

  it('refuses a profile the native side could not have produced', () => {
    expect(() => parseHostWindowProfile(null)).toThrow(/invalid window profile/u);
    expect(() => parseHostWindowProfile({ ...win11, family: 'win12' })).toThrow(
      /invalid window profile/u,
    );
    expect(() => parseHostWindowProfile({ ...win11, rounded: 'yes' })).toThrow(
      /invalid window profile/u,
    );
    expect(() => parseHostWindowProfile({ ...win11, buildNumber: 22631.5 })).toThrow(
      /invalid window profile/u,
    );
  });
});
