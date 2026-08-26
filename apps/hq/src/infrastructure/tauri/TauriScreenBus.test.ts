// @vitest-environment jsdom
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { screenBusProtocolVersion, type ScreenBusMessage } from '@gremuchaya/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriScreenBus, tauriScreenBusEventName } from './TauriScreenBus';

/*
 * `mockIPC(..., { shouldMockEvents: true })` is the real reason these tests can
 * make a claim about the adapter at all: it routes `plugin:event|emit` to every
 * handler registered through `plugin:event|listen` in the same process, which
 * is exactly the delivery rule the native side has -- an emit reaches every
 * webview *including the emitting one*. The echo-drop below is therefore
 * proven against the same behaviour the shell has, not against a stub that was
 * told to skip the sender.
 *
 * It ships inside `@tauri-apps/api` (already a dependency), so nothing was
 * added to `package.json` to test this.
 */
beforeEach(() => {
  Object.assign(globalThis, { isTauri: true });
  mockIPC(() => undefined, { shouldMockEvents: true });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('TauriScreenBus', () => {
  it('carries a payload to the other window and not back to the sender', async () => {
    const control = new TauriScreenBus();
    const screen = new TauriScreenBus();
    await Promise.all([control.ready, screen.ready]);
    const atScreen = vi.fn();
    const atControl = vi.fn();
    screen.subscribe(atScreen);
    control.subscribe(atControl);

    control.publish({ type: 'BLACKOUT', enabled: true });

    expect(atScreen).toHaveBeenCalledTimes(1);
    const received = atScreen.mock.calls[0]?.[0] as ScreenBusMessage;
    expect(received.protocol).toBe(screenBusProtocolVersion);
    expect(received.payload).toEqual({ type: 'BLACKOUT', enabled: true });
    // The emit came back to the control window too; the sender-id check is
    // what stops it running its own cue a second time.
    expect(atControl).not.toHaveBeenCalled();

    control.close();
    screen.close();
  });

  it('dispatches the same message once however many times it is delivered', async () => {
    const screen = new TauriScreenBus();
    await screen.ready;
    const listener = vi.fn();
    screen.subscribe(listener);
    const message: ScreenBusMessage = {
      protocol: screenBusProtocolVersion,
      id: 'cue-7',
      issuedAt: 1_000,
      senderId: 'control-window',
      payload: { type: 'FREEZE', enabled: true },
    };

    await emit(tauriScreenBusEventName, message);
    await emit(tauriScreenBusEventName, message);
    await emit(tauriScreenBusEventName, { ...message, issuedAt: 2_000 });

    expect(listener).toHaveBeenCalledTimes(1);
    screen.close();
  });

  it('drops anything that is not this protocol version', async () => {
    const screen = new TauriScreenBus();
    await screen.ready;
    const listener = vi.fn();
    screen.subscribe(listener);

    await emit(tauriScreenBusEventName, 'not-an-envelope');
    await emit(tauriScreenBusEventName, {
      protocol: screenBusProtocolVersion + 1,
      id: 'future',
      issuedAt: 1,
      senderId: 'other',
      payload: { type: 'BLACKOUT', enabled: true },
    });
    await emit(tauriScreenBusEventName, {
      protocol: screenBusProtocolVersion,
      id: 'no-payload',
      issuedAt: 1,
      senderId: 'other',
    });

    expect(listener).not.toHaveBeenCalled();
    screen.close();
  });

  it('stops delivering after close', async () => {
    // The mock warns when a callback it no longer holds is run, which is what
    // an unlisten looks like from its side.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const control = new TauriScreenBus();
    const screen = new TauriScreenBus();
    await Promise.all([control.ready, screen.ready]);
    const listener = vi.fn();
    screen.subscribe(listener);

    screen.close();
    control.publish({ type: 'BLACKOUT', enabled: false });

    expect(listener).not.toHaveBeenCalled();
    control.close();
    warn.mockRestore();
  });

  it('publishes nothing after close', async () => {
    const control = new TauriScreenBus();
    const screen = new TauriScreenBus();
    await Promise.all([control.ready, screen.ready]);
    const listener = vi.fn();
    screen.subscribe(listener);

    control.close();
    control.publish({ type: 'BLACKOUT', enabled: true });

    expect(listener).not.toHaveBeenCalled();
    screen.close();
  });
});
