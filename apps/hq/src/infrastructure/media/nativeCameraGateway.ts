import { invoke, isTauri } from '@tauri-apps/api/core';

const nativeCameraRetryDelaysMs = [500, 1_000, 2_000, 4_000, 8_000] as const;

export interface NativeCameraStream {
  readonly cameraId: string;
  readonly streamId: string;
  readonly manifestUrl: string;
  readonly generation: number;
  readonly transport: 'RTSP_GATEWAY';
  readonly state: 'ready';
}

export async function startNativeCameraStream(
  cameraId: string,
  consumerId: string,
): Promise<NativeCameraStream | null> {
  if (!isTauri()) return null;
  const value = await invoke<unknown>('start_camera_stream', { cameraId, consumerId });
  return parseNativeCameraStream(value, cameraId);
}

export async function stopNativeCameraStream(
  cameraId: string,
  consumerId: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('stop_camera_stream', { cameraId, consumerId });
}

export function getNativeCameraRetryDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) return nativeCameraRetryDelaysMs[0];
  return (
    nativeCameraRetryDelaysMs[Math.min(attempt, nativeCameraRetryDelaysMs.length - 1)] ?? 8_000
  );
}

export function parseNativeCameraStream(
  value: unknown,
  expectedCameraId: string,
): NativeCameraStream {
  if (!isRecord(value)) throw new Error('Native media gateway returned an invalid descriptor.');
  const { cameraId, streamId, manifestUrl, generation, transport, state } = value;
  if (
    cameraId !== expectedCameraId ||
    typeof streamId !== 'string' ||
    typeof manifestUrl !== 'string' ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    transport !== 'RTSP_GATEWAY' ||
    state !== 'ready'
  ) {
    throw new Error('Native media gateway returned an invalid descriptor.');
  }
  const manifest = new URL(manifestUrl);
  const pathSegments = manifest.pathname.split('/');
  if (
    !/^camera-[a-z0-9_-]+$/u.test(streamId) ||
    manifest.protocol !== 'http:' ||
    manifest.hostname !== '127.0.0.1' ||
    manifest.username !== '' ||
    manifest.password !== '' ||
    manifest.search !== '' ||
    manifest.hash !== '' ||
    pathSegments.length !== 6 ||
    pathSegments[1] !== 'v1' ||
    pathSegments[2] !== 'streams' ||
    pathSegments[3] !== streamId ||
    !/^[0-9a-f]{64}$/u.test(pathSegments[4] ?? '') ||
    pathSegments[5] !== 'index.m3u8'
  ) {
    throw new Error('Native media gateway returned a non-loopback manifest URL.');
  }
  return { cameraId, streamId, manifestUrl, generation, transport, state };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
