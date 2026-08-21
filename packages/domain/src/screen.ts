import type { ModuleId, ScreenId } from './ids.js';

export type ModulePayload = Readonly<Record<string, unknown>>;

export interface ScreenState {
  readonly id: ScreenId;
  readonly module: ModuleId;
  readonly payload: ModulePayload;
  readonly blackout: boolean;
  readonly standby: boolean;
  readonly frozen: boolean;
  readonly glitch: number;
  readonly revision: number;
}

export interface ModulePreset {
  readonly module: ModuleId;
  readonly payload: ModulePayload;
}

export interface ScreenHeartbeat {
  readonly screenId: ScreenId;
  readonly receivedAt: number;
  readonly route: string;
  readonly sceneId: string | null;
  readonly module: ModuleId;
}

export type ScreenConnectionStatus = 'online' | 'stale' | 'offline';

export interface ScreenConnection {
  readonly screenId: ScreenId;
  readonly status: ScreenConnectionStatus;
  readonly lastHeartbeatAt: number | null;
  readonly latencyMs: number | null;
}

export function createInitialScreenState(id: ScreenId): ScreenState {
  return {
    id,
    module: 'idle',
    payload: { preset: 'hq-default' },
    blackout: false,
    standby: false,
    frozen: false,
    glitch: 0,
    revision: 0,
  };
}
