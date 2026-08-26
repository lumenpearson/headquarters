import { invoke, isTauri } from '@tauri-apps/api/core';

/** The states `MediaWorkerState::public_name` can report, and nothing else. */
export const nativeMediaStreamStates = ['starting', 'ready', 'reconnecting', 'degraded'] as const;

export type NativeMediaStreamState = (typeof nativeMediaStreamStates)[number];

/** One RTSP→HLS worker, as `MediaGatewayStreamHealth` serialises it. */
export interface NativeMediaStreamHealth {
  readonly cameraId: string;
  readonly streamId: string;
  readonly state: NativeMediaStreamState;
  readonly consumers: number;
  readonly consecutiveFailures: number;
  readonly totalRestarts: number;
  /** Age of the newest manifest segment, or `null` before the first one lands. */
  readonly manifestAgeMs: number | null;
}

/** Mirrors `MediaGatewayStatus` in `src-tauri/src/media_gateway.rs`. */
export interface NativeMediaGatewayStatus {
  readonly available: boolean;
  readonly origin: string;
  readonly configuredStreams: number;
  readonly activeStreams: number;
  readonly startingStreams: number;
  readonly reconnectingStreams: number;
  readonly failedStreams: number;
  readonly maxWorkers: number;
  readonly streams: readonly NativeMediaStreamHealth[];
}

/**
 * Reads the loopback media gateway's own counters.
 *
 * `get_media_gateway_status` has been registered since the gateway landed and
 * called from nowhere, so the only way to learn whether a stream was
 * reconnecting was to read the ffmpeg output in a terminal. Returns `null` --
 * not a zeroed status -- when there is no native shell, because a web session
 * has no gateway at all and reporting "0 streams, 0 failures" would read as a
 * healthy gateway rather than as an absent one.
 */
export async function readNativeMediaGatewayStatus(): Promise<NativeMediaGatewayStatus | null> {
  if (!isTauri()) return null;
  return parseNativeMediaGatewayStatus(await invoke<unknown>('get_media_gateway_status'));
}

export function parseNativeMediaGatewayStatus(value: unknown): NativeMediaGatewayStatus {
  if (!isRecord(value)) throw new Error('Native media gateway returned an invalid status.');
  const {
    available,
    origin,
    configuredStreams,
    activeStreams,
    startingStreams,
    reconnectingStreams,
    failedStreams,
    maxWorkers,
    streams,
  } = value;
  if (
    typeof available !== 'boolean' ||
    typeof origin !== 'string' ||
    !isCount(configuredStreams) ||
    !isCount(activeStreams) ||
    !isCount(startingStreams) ||
    !isCount(reconnectingStreams) ||
    !isCount(failedStreams) ||
    !isCount(maxWorkers) ||
    !Array.isArray(streams)
  ) {
    throw new Error('Native media gateway returned an invalid status.');
  }
  return {
    available,
    origin,
    configuredStreams,
    activeStreams,
    startingStreams,
    reconnectingStreams,
    failedStreams,
    maxWorkers,
    streams: streams.map(parseStreamHealth),
  };
}

function parseStreamHealth(value: unknown): NativeMediaStreamHealth {
  if (!isRecord(value)) throw new Error('Native media gateway returned an invalid stream.');
  const {
    cameraId,
    streamId,
    state,
    consumers,
    consecutiveFailures,
    totalRestarts,
    manifestAgeMs,
  } = value;
  if (
    typeof cameraId !== 'string' ||
    typeof streamId !== 'string' ||
    !isStreamState(state) ||
    !isCount(consumers) ||
    !isCount(consecutiveFailures) ||
    !isCount(totalRestarts) ||
    !(manifestAgeMs === null || manifestAgeMs === undefined || isCount(manifestAgeMs))
  ) {
    throw new Error('Native media gateway returned an invalid stream.');
  }
  return {
    cameraId,
    streamId,
    state,
    consumers,
    consecutiveFailures,
    totalRestarts,
    manifestAgeMs: isCount(manifestAgeMs) ? manifestAgeMs : null,
  };
}

function isStreamState(value: unknown): value is NativeMediaStreamState {
  return (
    typeof value === 'string' && (nativeMediaStreamStates as readonly string[]).includes(value)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
