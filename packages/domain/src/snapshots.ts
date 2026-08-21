import type { SceneId, ScreenId } from './ids.js';
import type { ScreenState } from './screen.js';
import type { VirtualPath } from './virtualPath.js';

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type WorkspaceDocumentKind =
  'person' | 'vehicle' | 'image' | 'video' | 'map' | 'graph' | 'text' | 'metadata';

export interface WorkspaceWindow {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly kind: WorkspaceDocumentKind;
  readonly bounds: WindowBounds;
  readonly state: 'normal' | 'maximized' | 'minimized';
  readonly zOrder: number;
}

export interface ExplorerSnapshot {
  readonly activePath: VirtualPath;
  readonly selectedNodeId: string | null;
  readonly expandedNodeIds: readonly string[];
  readonly viewMode: 'list' | 'grid';
  readonly searchQuery: string;
}

export interface WorkspaceSnapshot {
  readonly activeSection: string;
  readonly windows: readonly WorkspaceWindow[];
  readonly activeDocumentId: string | null;
}

export interface ClockSnapshot {
  readonly mode: 'real' | 'fixed' | 'scene';
  readonly fixedTime: string;
}

export interface AppSnapshot {
  readonly version: 1;
  readonly name: string;
  readonly createdAt: string;
  readonly sceneId: SceneId | null;
  readonly cueIndex: number;
  readonly screens: Readonly<Record<ScreenId, ScreenState>>;
  readonly explorer: ExplorerSnapshot;
  readonly workspace: WorkspaceSnapshot;
  readonly clock: ClockSnapshot;
  readonly wallPreset: string;
  readonly developerStateOverrides: Readonly<Record<string, unknown>>;
}
