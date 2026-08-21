import { describe, expect, it } from 'vitest';

import { getNativeCameraRetryDelay, parseNativeCameraStream } from './nativeCameraGateway';

describe('native camera gateway boundary', () => {
  const descriptor = {
    cameraId: 'K-17',
    streamId: 'camera-k-17',
    manifestUrl:
      'http://127.0.0.1:4178/v1/streams/camera-k-17/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/index.m3u8',
    generation: 4,
    transport: 'RTSP_GATEWAY',
    state: 'ready',
  } as const;

  it('accepts only the expected camera and loopback HLS manifest', () => {
    expect(parseNativeCameraStream(descriptor, 'K-17')).toEqual(descriptor);
    expect(() => parseNativeCameraStream(descriptor, 'CAM-02')).toThrow(/invalid descriptor/u);
  });

  it('rejects credentials, remote hosts, query grants and non-HLS assets', () => {
    for (const manifestUrl of [
      descriptor.manifestUrl.replace('127.0.0.1', 'gateway.example.test'),
      descriptor.manifestUrl.replace('http://', 'http://operator:secret@'),
      `${descriptor.manifestUrl}?rtsp=secret`,
      descriptor.manifestUrl.replace('index.m3u8', 'camera.json'),
    ]) {
      expect(() => parseNativeCameraStream({ ...descriptor, manifestUrl }, 'K-17')).toThrow(
        /manifest URL/u,
      );
    }
  });

  it('bounds native reconnect delays without using render-time randomness', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(getNativeCameraRetryDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
    expect(getNativeCameraRetryDelay(-1)).toBe(500);
    expect(getNativeCameraRetryDelay(Number.NaN)).toBe(500);
  });
});
