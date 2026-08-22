import type { Camera } from '@gremuchaya/domain';

import { queryRecords } from '@/application/records/query';

export type CameraStreamTransport = 'DEMO_VIDEO' | 'LOCAL_MATERIAL' | 'WEBCAM' | 'RTSP_GATEWAY';
export type CameraRegistryFilter = 'all' | 'online' | 'alert' | 'lost';
export type CameraRegistrySort = 'registry' | 'id' | 'signal' | 'sector';

export interface CameraStreamDescriptor {
  readonly cameraId: string;
  readonly streamId: string;
  readonly browserSource: string;
  readonly fallbackSource: string;
  readonly thumbnailSource: string;
  readonly transport: CameraStreamTransport;
  readonly webcamEligible: boolean;
}

export interface CameraStreamRegistryOptions {
  readonly gatewayOrigin?: string;
  readonly nativeGatewayEnabled?: boolean;
  readonly localSources?: Readonly<Record<string, string>>;
}

export interface CameraRegistryEntry {
  readonly camera: Camera;
  readonly stream: CameraStreamDescriptor;
}

export interface CameraRegistryQuery {
  readonly filter: CameraRegistryFilter;
  readonly sort: CameraRegistrySort;
  readonly page: number;
  readonly pageSize: number;
}

export interface CameraRegistryPage {
  readonly items: readonly CameraRegistryEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

const localSurveillanceSource = '/assets/video/surveillance-k17.webm';
const thumbnailCount = 12;

export function createCameraStreamRegistry(
  cameras: readonly Camera[],
  options: CameraStreamRegistryOptions = {},
): Readonly<Record<string, CameraStreamDescriptor>> {
  const normalizedGatewayOrigin = normalizeGatewayOrigin(
    options.gatewayOrigin ?? process.env.NEXT_PUBLIC_HQ_RTSP_GATEWAY_ORIGIN,
  );
  const nativeGatewayEnabled =
    options.nativeGatewayEnabled ??
    process.env.NEXT_PUBLIC_HQ_ENABLE_NATIVE_RTSP_GATEWAY === 'true';
  return Object.fromEntries(
    cameras.map((camera, index) => {
      const streamId = `camera-${camera.id.toLocaleLowerCase('en-US')}`;
      const localSource = normalizeLocalMediaSource(options.localSources?.[camera.id]);
      const gatewaySelected =
        localSource === null && (normalizedGatewayOrigin !== null || nativeGatewayEnabled);
      const browserSource =
        localSource ??
        (normalizedGatewayOrigin === null
          ? localSurveillanceSource
          : `${normalizedGatewayOrigin}/v1/streams/${encodeURIComponent(streamId)}/index.m3u8`);
      return [
        camera.id,
        {
          cameraId: camera.id,
          streamId,
          browserSource,
          fallbackSource: localSurveillanceSource,
          thumbnailSource: `/assets/video/camera-${String((index % thumbnailCount) + 1).padStart(2, '0')}.webp`,
          transport:
            localSource !== null
              ? 'LOCAL_MATERIAL'
              : gatewaySelected
                ? 'RTSP_GATEWAY'
                : 'DEMO_VIDEO',
          webcamEligible: true,
        } satisfies CameraStreamDescriptor,
      ];
    }),
  );
}

export function normalizeLocalMediaSource(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (candidate === undefined || candidate === '') return null;
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  if (candidate.startsWith('blob:')) return candidate;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !/^\/v1\/material-playback\/[0-9a-f-]{36}\/[0-9a-f]{64}$/iu.test(url.pathname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function queryCameraRegistry(
  cameras: readonly Camera[],
  registry: Readonly<Record<string, CameraStreamDescriptor>>,
  query: CameraRegistryQuery,
): CameraRegistryPage {
  const page = queryRecords(cameras, {
    page: query.page,
    pageSize: query.pageSize,
    filters: [(camera) => matchesFilter(camera, query.filter)],
    // `registry` is the declared order, which is the input order: no
    // comparator rather than one that reproduces it.
    ...(query.sort === 'registry' ? {} : { comparator: cameraComparator(query.sort) }),
  });

  return {
    items: page.items.flatMap((camera): readonly CameraRegistryEntry[] => {
      const stream = registry[camera.id];
      return stream === undefined ? [] : [{ camera, stream }];
    }),
    page: page.page,
    pageSize: page.pageSize,
    totalItems: page.total,
    totalPages: page.pageCount,
  };
}

export function normalizeGatewayOrigin(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (candidate === undefined || candidate === '') return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      return null;
    }
    const path = url.pathname.replace(/\/+$/u, '');
    return `${url.origin}${path === '/' ? '' : path}`;
  } catch {
    return null;
  }
}

function matchesFilter(camera: Camera, filter: CameraRegistryFilter): boolean {
  if (filter === 'online') return camera.status === 'ACTIVE';
  if (filter === 'alert') return camera.status === 'ALERT';
  if (filter === 'lost') return camera.status === 'SIGNAL_LOST';
  return true;
}

function cameraComparator(sort: CameraRegistrySort): (left: Camera, right: Camera) => number {
  if (sort === 'signal') {
    return (left, right) => right.signal - left.signal || left.id.localeCompare(right.id);
  }
  if (sort === 'sector') {
    return (left, right) =>
      left.sectorId.localeCompare(right.sectorId) || left.id.localeCompare(right.id);
  }
  return (left, right) => left.id.localeCompare(right.id, 'en-US', { numeric: true });
}
