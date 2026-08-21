import { assertNever } from './errors.js';

export type SatelliteState =
  | { readonly status: 'acquiring' }
  | { readonly status: 'zooming'; readonly level: number; readonly targetId?: string }
  | { readonly status: 'tracking'; readonly targetId: string; readonly quality: number }
  | { readonly status: 'degraded'; readonly quality: number; readonly targetId?: string }
  | { readonly status: 'lost'; readonly lastKnownTargetId?: string };

export type SatelliteEvent =
  | { readonly type: 'ACQUIRE' }
  | { readonly type: 'ZOOM'; readonly level: number; readonly targetId?: string }
  | { readonly type: 'TRACK'; readonly targetId: string; readonly quality: number }
  | { readonly type: 'DEGRADE'; readonly quality: number }
  | { readonly type: 'LOSE' }
  | { readonly type: 'RESET' };

export function transitionSatellite(state: SatelliteState, event: SatelliteEvent): SatelliteState {
  switch (event.type) {
    case 'ACQUIRE':
    case 'RESET':
      return { status: 'acquiring' };
    case 'ZOOM':
      return event.targetId === undefined
        ? { status: 'zooming', level: event.level }
        : { status: 'zooming', level: event.level, targetId: event.targetId };
    case 'TRACK':
      return { status: 'tracking', targetId: event.targetId, quality: event.quality };
    case 'DEGRADE': {
      const targetId = getSatelliteTargetId(state);
      return targetId === undefined
        ? { status: 'degraded', quality: event.quality }
        : { status: 'degraded', quality: event.quality, targetId };
    }
    case 'LOSE': {
      const lastKnownTargetId = getSatelliteTargetId(state);
      return lastKnownTargetId === undefined
        ? { status: 'lost' }
        : { status: 'lost', lastKnownTargetId };
    }
    default:
      return assertNever(event, 'satellite event');
  }
}

function getSatelliteTargetId(state: SatelliteState): string | undefined {
  switch (state.status) {
    case 'tracking':
      return state.targetId;
    case 'zooming':
    case 'degraded':
      return state.targetId;
    case 'lost':
      return state.lastKnownTargetId;
    case 'acquiring':
      return undefined;
    default:
      return assertNever(state, 'satellite state');
  }
}

export type CommsState =
  | { readonly status: 'ringing'; readonly target: string }
  | { readonly status: 'connecting'; readonly target: string; readonly startedAt: number }
  | {
      readonly status: 'connected';
      readonly target: string;
      readonly connectedAt: number;
      readonly intercept: boolean;
    }
  | { readonly status: 'ended'; readonly target: string; readonly endedAt: number };

export type CommsEvent =
  | { readonly type: 'RING'; readonly target: string }
  | { readonly type: 'CONNECT'; readonly at: number }
  | { readonly type: 'CONNECTED'; readonly at: number; readonly intercept: boolean }
  | { readonly type: 'END'; readonly at: number };

export function transitionComms(state: CommsState, event: CommsEvent): CommsState {
  switch (event.type) {
    case 'RING':
      return { status: 'ringing', target: event.target };
    case 'CONNECT':
      return { status: 'connecting', target: state.target, startedAt: event.at };
    case 'CONNECTED':
      return {
        status: 'connected',
        target: state.target,
        connectedAt: event.at,
        intercept: event.intercept,
      };
    case 'END':
      return { status: 'ended', target: state.target, endedAt: event.at };
    default:
      return assertNever(event, 'comms event');
  }
}

export type SecurityState =
  | { readonly status: 'online'; readonly cameraId: string }
  | { readonly status: 'disabled'; readonly cameraId: string; readonly disabledAt: number }
  | { readonly status: 'reconnecting'; readonly cameraId: string; readonly attempt: number };

export type SecurityEvent =
  | { readonly type: 'DISABLE'; readonly at: number }
  | { readonly type: 'RECONNECT'; readonly attempt: number }
  | { readonly type: 'RESTORE' };

export function transitionSecurity(state: SecurityState, event: SecurityEvent): SecurityState {
  switch (event.type) {
    case 'DISABLE':
      return { status: 'disabled', cameraId: state.cameraId, disabledAt: event.at };
    case 'RECONNECT':
      return { status: 'reconnecting', cameraId: state.cameraId, attempt: event.attempt };
    case 'RESTORE':
      return { status: 'online', cameraId: state.cameraId };
    default:
      return assertNever(event, 'security event');
  }
}

export type MediaState =
  | { readonly status: 'idle' }
  | { readonly status: 'preloading'; readonly assetId: string; readonly progress: number }
  | { readonly status: 'ready'; readonly assetId: string }
  | { readonly status: 'playing'; readonly assetId: string; readonly startedAt: number }
  | { readonly status: 'paused'; readonly assetId: string; readonly positionMs: number }
  | { readonly status: 'failed'; readonly assetId: string; readonly reason: string };

export type ExplorerMountState =
  | { readonly status: 'online'; readonly sourceId: string; readonly indexedAt: number }
  | { readonly status: 'offline'; readonly sourceId: string; readonly reason?: string }
  | { readonly status: 'permission-required'; readonly sourceId: string }
  | { readonly status: 'empty'; readonly sourceId: string };
