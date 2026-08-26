// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseNativeMediaGatewayStatus,
  readNativeMediaGatewayStatus,
} from './nativeMediaGatewayStatus';

/** The shape `MediaGatewayStatus` serialises, field for field. */
const nativeStatus = {
  available: true,
  origin: 'http://127.0.0.1:4178',
  configuredStreams: 3,
  activeStreams: 2,
  startingStreams: 0,
  reconnectingStreams: 1,
  failedStreams: 0,
  maxWorkers: 4,
  streams: [
    {
      cameraId: 'K-17',
      streamId: 'camera-k-17',
      state: 'ready',
      consumers: 2,
      consecutiveFailures: 0,
      totalRestarts: 1,
      manifestAgeMs: 1_400,
    },
    {
      cameraId: 'K-21',
      streamId: 'camera-k-21',
      state: 'reconnecting',
      consumers: 1,
      consecutiveFailures: 2,
      totalRestarts: 5,
      manifestAgeMs: null,
    },
  ],
};

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('readNativeMediaGatewayStatus', () => {
  it('reads the counters the native gateway reports', async () => {
    Object.assign(globalThis, { isTauri: true });
    mockIPC((command) => (command === 'get_media_gateway_status' ? nativeStatus : undefined));

    await expect(readNativeMediaGatewayStatus()).resolves.toEqual(nativeStatus);
  });

  it('answers with no status at all in a web session', async () => {
    // Not a zeroed status: "no gateway here" and "a gateway with nothing
    // running" are different answers, and only one of them is a fault.
    await expect(readNativeMediaGatewayStatus()).resolves.toBeNull();
  });
});

describe('parseNativeMediaGatewayStatus', () => {
  it('reads a missing manifest age as never-yet-written', () => {
    const parsed = parseNativeMediaGatewayStatus({
      ...nativeStatus,
      streams: [{ ...nativeStatus.streams[0], manifestAgeMs: undefined }],
    });

    expect(parsed.streams[0]?.manifestAgeMs).toBeNull();
  });

  it('accepts only the four states the worker can publish', () => {
    for (const state of ['starting', 'ready', 'reconnecting', 'degraded']) {
      const parsed = parseNativeMediaGatewayStatus({
        ...nativeStatus,
        streams: [{ ...nativeStatus.streams[0], state }],
      });
      expect(parsed.streams[0]?.state).toBe(state);
    }
    expect(() =>
      parseNativeMediaGatewayStatus({
        ...nativeStatus,
        streams: [{ ...nativeStatus.streams[0], state: 'stopped' }],
      }),
    ).toThrow(/invalid stream/u);
  });

  it('refuses a status the gateway could not have produced', () => {
    expect(() => parseNativeMediaGatewayStatus(null)).toThrow(/invalid status/u);
    expect(() => parseNativeMediaGatewayStatus({ ...nativeStatus, origin: 4178 })).toThrow(
      /invalid status/u,
    );
    expect(() => parseNativeMediaGatewayStatus({ ...nativeStatus, activeStreams: -1 })).toThrow(
      /invalid status/u,
    );
    expect(() => parseNativeMediaGatewayStatus({ ...nativeStatus, streams: {} })).toThrow(
      /invalid status/u,
    );
  });
});
