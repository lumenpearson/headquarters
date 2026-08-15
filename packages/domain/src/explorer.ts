import type { AssetId, EntityId, ScreenId } from './ids.js';
import type { VirtualPath } from './virtualPath.js';

export type ExplorerIconHint =
  'folder' | 'document' | 'photo' | 'video' | 'audio' | 'map' | 'graph' | 'case';

export interface ExplorerNodeBase {
  readonly id: string;
  readonly name: string;
  readonly path: VirtualPath;
  readonly modifiedAt?: string;
  readonly displaySize?: number;
  readonly iconHint?: ExplorerIconHint;
  readonly tags?: readonly string[];
  readonly pinnedOrder?: number;
}

export interface RealFileNode extends ExplorerNodeBase {
  readonly kind: 'real-file';
  readonly sourceId: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface RealDirectoryNode extends ExplorerNodeBase {
  readonly kind: 'real-directory';
  readonly sourceId: string;
}

export type EmulatedFileContent =
  | { readonly renderer: 'person-dossier'; readonly entityId: EntityId }
  | { readonly renderer: 'vehicle-dossier'; readonly entityId: EntityId }
  | { readonly renderer: 'text'; readonly body: string }
  | { readonly renderer: 'image'; readonly assetId: AssetId }
  | { readonly renderer: 'video'; readonly assetId: AssetId }
  | { readonly renderer: 'graph'; readonly graphId: string }
  | { readonly renderer: 'map'; readonly presetId: string }
  | { readonly renderer: 'table'; readonly tableId: string };

export interface EmulatedFileNode extends ExplorerNodeBase {
  readonly kind: 'emulated-file';
  readonly mimeType: string;
  readonly emulation: EmulatedFileContent;
}

export interface EmulatedDirectoryNode extends ExplorerNodeBase {
  readonly kind: 'emulated-directory';
  readonly children: readonly ExplorerNode[];
  readonly presentationProfileId?: string;
}

export interface MountNode extends ExplorerNodeBase {
  readonly kind: 'mount';
  readonly sourceId: string;
  readonly status: 'online' | 'offline' | 'permission-required' | 'empty';
}

export type ExplorerNode =
  RealFileNode | RealDirectoryNode | EmulatedFileNode | EmulatedDirectoryNode | MountNode;

export interface FileStat {
  readonly path: VirtualPath;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
}

export type ReadableFileContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'url'; readonly url: string };

export interface ReadableFile {
  readonly node: RealFileNode;
  readonly content: ReadableFileContent;
}

export type FileSourceEvent =
  | { readonly type: 'FILE_ADDED'; readonly sourceId: string; readonly path: VirtualPath }
  | { readonly type: 'FILE_CHANGED'; readonly sourceId: string; readonly path: VirtualPath }
  | { readonly type: 'FILE_REMOVED'; readonly sourceId: string; readonly path: VirtualPath }
  | { readonly type: 'DIRECTORY_CHANGED'; readonly sourceId: string; readonly path: VirtualPath }
  | { readonly type: 'FILE_READY'; readonly sourceId: string; readonly path: VirtualPath };

export interface Disposable {
  dispose(): void;
}

export type FileSourceListener = (event: FileSourceEvent) => void;

export interface FileSourcePort {
  readonly id: string;
  readonly label: string;
  list(path: VirtualPath, signal?: AbortSignal): Promise<readonly ExplorerNode[]>;
  stat(path: VirtualPath, signal?: AbortSignal): Promise<FileStat | null>;
  read(path: VirtualPath, signal?: AbortSignal): Promise<ReadableFile>;
  watch?(path: VirtualPath, listener: FileSourceListener): Promise<Disposable>;
}

export interface VirtualMountRule {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly virtualPath: VirtualPath;
  readonly priority: number;
}

export interface FileDisplayOverride {
  readonly sourceId: string;
  readonly physicalPath: string;
  readonly displayName?: string;
  readonly virtualPath?: VirtualPath;
  readonly hidden?: boolean;
}

export type AssetLocation =
  | { readonly kind: 'static'; readonly url: string }
  | { readonly kind: 'projected-file'; readonly nodeId: string }
  | { readonly kind: 'emulated'; readonly renderer: string };

export interface AssetDefinition {
  readonly id: AssetId;
  readonly type: 'image' | 'video' | 'audio' | 'map' | 'font' | 'document';
  readonly status: 'placeholder' | 'approved' | 'final' | 'missing';
  readonly location: AssetLocation;
  readonly expectedMimeType: string;
  readonly notes?: string;
}

export type WorkspaceDocument =
  | {
      readonly kind: 'person';
      readonly id: string;
      readonly entityId: EntityId;
      readonly title: string;
    }
  | {
      readonly kind: 'vehicle';
      readonly id: string;
      readonly entityId: EntityId;
      readonly title: string;
    }
  | {
      readonly kind: 'image';
      readonly id: string;
      readonly assetId: AssetId;
      readonly title: string;
    }
  | {
      readonly kind: 'video';
      readonly id: string;
      readonly assetId: AssetId;
      readonly title: string;
    }
  | { readonly kind: 'map'; readonly id: string; readonly presetId: string; readonly title: string }
  | {
      readonly kind: 'graph';
      readonly id: string;
      readonly graphId: string;
      readonly title: string;
    }
  | { readonly kind: 'text'; readonly id: string; readonly body: string; readonly title: string }
  | {
      readonly kind: 'metadata';
      readonly id: string;
      readonly node: ExplorerNode;
      readonly title: string;
    };

export interface SendDocumentToScreenCommand {
  readonly type: 'SEND_DOCUMENT_TO_SCREEN';
  readonly documentId: string;
  readonly screenId: ScreenId;
}

export interface FolderPresentationProfile {
  readonly id: string;
  readonly view: 'files' | 'people' | 'vehicles' | 'media' | 'events' | 'evidence';
  readonly columns: readonly ColumnDefinition[];
  readonly defaultSort: SortDefinition;
}

export interface ColumnDefinition {
  readonly id: string;
  readonly label: string;
  readonly width: number | string;
}

export interface SortDefinition {
  readonly by: 'name' | 'modifiedAt' | 'size' | 'kind';
  readonly direction: 'asc' | 'desc';
}

export interface ExplorerIndex {
  readonly byId: ReadonlyMap<string, ExplorerNode>;
  readonly childrenById: ReadonlyMap<string, readonly string[]>;
  readonly byPath: ReadonlyMap<VirtualPath, ExplorerNode>;
}
