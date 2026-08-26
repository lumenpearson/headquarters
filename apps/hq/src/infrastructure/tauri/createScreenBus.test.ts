// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserScreenBus } from '@/infrastructure/browser/BrowserScreenBus';

import { createScreenBus } from './createScreenBus';
import { TauriScreenBus } from './TauriScreenBus';

/*
 * `isTauri()` reads `globalThis.isTauri`, which the native shell injects and no
 * browser has. Setting it is the whole difference between the two builds as far
 * as this selection is concerned, so the test sets exactly that and nothing
 * else.
 */
afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('createScreenBus', () => {
  it('uses the Tauri event bus inside the native shell', () => {
    Object.assign(globalThis, { isTauri: true });
    mockIPC(() => undefined, { shouldMockEvents: true });

    const bus = createScreenBus();

    expect(bus).toBeInstanceOf(TauriScreenBus);
    bus.close();
  });

  it('falls back to BroadcastChannel in a browser session', () => {
    const bus = createScreenBus();

    expect(bus).toBeInstanceOf(BrowserScreenBus);
    bus.close();
  });
});
