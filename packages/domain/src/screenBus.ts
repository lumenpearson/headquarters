import type { RuntimeSnapshotState } from './scene.js';
import type { CueAction } from './scene.js';
import type { ScreenHeartbeat, ScreenState } from './screen.js';

export const screenBusProtocolVersion = 1 as const;

export type ScreenBusPayload =
  | { readonly type: 'SCENE_LOADED'; readonly state: RuntimeSnapshotState }
  | { readonly type: 'CUE'; readonly action: CueAction; readonly cueIndex: number }
  | { readonly type: 'SCREEN_PATCH'; readonly screen: ScreenState }
  | { readonly type: 'BLACKOUT'; readonly enabled: boolean }
  | { readonly type: 'FREEZE'; readonly enabled: boolean }
  | { readonly type: 'RESET'; readonly state: RuntimeSnapshotState }
  | { readonly type: 'PING'; readonly nonce: string }
  | { readonly type: 'PONG'; readonly heartbeat: ScreenHeartbeat; readonly nonce: string }
  | { readonly type: 'REQUEST_CURRENT_STATE'; readonly requesterId: string }
  | { readonly type: 'CURRENT_STATE'; readonly state: RuntimeSnapshotState };

export interface ScreenBusMessage {
  readonly protocol: typeof screenBusProtocolVersion;
  readonly id: string;
  readonly issuedAt: number;
  readonly senderId: string;
  readonly payload: ScreenBusPayload;
}

export type ScreenBusListener = (message: ScreenBusMessage) => void;

export interface ScreenBusPort {
  publish(payload: ScreenBusPayload): void;
  subscribe(listener: ScreenBusListener): () => void;
  close(): void;
}
