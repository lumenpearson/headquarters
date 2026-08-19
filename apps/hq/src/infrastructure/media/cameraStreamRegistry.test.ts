import type { Camera } from '@gremuchaya/domain';
import { describe, expect, it } from 'vitest';

import {
  createCameraStreamRegistry,
  normalizeGatewayOrigin,
  normalizeLocalMediaSource,
  queryCameraRegistry,
} from './cameraStreamRegistry';

function camera(index: number, status: Camera['status'] = 'ACTIVE'): Camera {
  return {
    id: index === 0 ? 'K-17' : `CAM-${String(index).padStart(2, '0')}`,
    objectId: `K-${String(index).padStart(2, '0')}`,
    location: `POST ${index}`,
    sectorId: `SEC-${String(index % 4).padStart(2, '0')}`,
    position: { x: 50, y: 50, lat: 55.75, lng: 37.61 },
    status,
    signal: 50 + index,
    resolution: '1920×1080',
    fps: 25,
    bitrate: '4.2 Mbit/s',
    codec: 'H.264',
    recording: true,
    ptz: true,
    uptime: '24ч 00м',
  };
}

describe('camera stream registry', () => {
  const cameras = Array.from({ length: 16 }, (_, index) =>
    camera(index, index === 13 ? 'SIGNAL_LOST' : index === 6 ? 'ALERT' : 'ACTIVE'),
  );

  it('keeps credentials and RTSP URLs out of the browser registry', () => {
    const registry = createCameraStreamRegistry(cameras, {
      gatewayOrigin: 'https://gateway.example.test/media/',
    });
    expect(registry['K-17']).toMatchObject({
      transport: 'RTSP_GATEWAY',
      browserSource: 'https://gateway.example.test/media/v1/streams/camera-k-17/index.m3u8',
    });
    expect(JSON.stringify(registry)).not.toContain('rtsp://');
    expect(JSON.stringify(registry)).not.toContain('@');
  });

  it('uses demo video by default and wraps twelve available thumbnails', () => {
    const registry = createCameraStreamRegistry(cameras, {
      gatewayOrigin: '',
      nativeGatewayEnabled: false,
    });
    expect(Object.keys(registry)).toHaveLength(16);
    expect(registry['K-17']?.transport).toBe('DEMO_VIDEO');
    expect(registry['K-17']?.webcamEligible).toBe(true);
    expect(registry['CAM-12']?.thumbnailSource).toBe('/assets/video/camera-01.webp');
  });

  it('keeps native RTSP opt-in and lets an assigned local material win', () => {
    const native = createCameraStreamRegistry(cameras, { nativeGatewayEnabled: true });
    expect(native['K-17']?.transport).toBe('RTSP_GATEWAY');
    expect(native['K-17']?.browserSource).toBe('/assets/video/surveillance-k17.webm');

    const local = createCameraStreamRegistry(cameras, {
      nativeGatewayEnabled: true,
      localSources: { 'K-17': '/materials/training/camera-k17.webm' },
    });
    expect(local['K-17']).toMatchObject({
      transport: 'LOCAL_MATERIAL',
      browserSource: '/materials/training/camera-k17.webm',
    });
  });

  it('paginates the complete registry and filters signal-loss channels', () => {
    const registry = createCameraStreamRegistry(cameras);
    const secondPage = queryCameraRegistry(cameras, registry, {
      filter: 'all',
      sort: 'registry',
      page: 2,
      pageSize: 12,
    });
    expect(secondPage.items).toHaveLength(4);
    expect(secondPage.totalItems).toBe(16);
    expect(secondPage.totalPages).toBe(2);

    const lost = queryCameraRegistry(cameras, registry, {
      filter: 'lost',
      sort: 'signal',
      page: 1,
      pageSize: 12,
    });
    expect(lost.items.map((entry) => entry.camera.id)).toEqual(['CAM-13']);

    const strongest = queryCameraRegistry(cameras, registry, {
      filter: 'all',
      sort: 'signal',
      page: 1,
      pageSize: 12,
    });
    expect(strongest.items[0]?.camera.id).toBe('CAM-15');
  });

  it('rejects credentialed, query-bearing and non-http gateway origins', () => {
    expect(normalizeGatewayOrigin('rtsp://camera.local/live')).toBeNull();
    expect(normalizeGatewayOrigin('https://operator:secret@gateway.test')).toBeNull();
    expect(normalizeGatewayOrigin('https://gateway.test?token=secret')).toBeNull();
    expect(normalizeGatewayOrigin('https://gateway.test/base/')).toBe('https://gateway.test/base');
  });

  it('accepts only same-origin, Blob or exact loopback-grant local material sources', () => {
    const grantId = '018f0f1a-8000-7000-8000-000000000000';
    const token = 'a'.repeat(64);
    expect(normalizeLocalMediaSource('/materials/camera.webm')).toBe('/materials/camera.webm');
    expect(normalizeLocalMediaSource('blob:https://hq.local/opaque')).toBe(
      'blob:https://hq.local/opaque',
    );
    expect(
      normalizeLocalMediaSource(`http://127.0.0.1:4177/v1/material-playback/${grantId}/${token}`),
    ).toBe(`http://127.0.0.1:4177/v1/material-playback/${grantId}/${token}`);
    expect(normalizeLocalMediaSource('//remote.invalid/camera.webm')).toBeNull();
    expect(normalizeLocalMediaSource('https://remote.invalid/camera.webm')).toBeNull();
    expect(
      normalizeLocalMediaSource(
        `http://127.0.0.1:4177/v1/material-playback/${grantId}/${token}?path=secret`,
      ),
    ).toBeNull();
    expect(normalizeLocalMediaSource('javascript:alert(1)')).toBeNull();
  });
});
