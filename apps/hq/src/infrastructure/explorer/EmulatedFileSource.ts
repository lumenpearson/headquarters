import type { EmulatedNodeConfig } from '@gremuchaya/config';
import {
  createVirtualPath,
  type EmulatedDirectoryNode,
  type EmulatedFileNode,
  type ExplorerNode,
  type FileSourcePort,
  type FileStat,
  type ReadableFile,
  type VirtualPath,
} from '@gremuchaya/domain';

export class EmulatedFileSource implements FileSourcePort {
  readonly id = 'emulated';
  readonly label = 'ПОСТАНОВОЧНАЯ ФАЙЛОВАЯ СИСТЕМА';
  readonly #roots: readonly EmulatedDirectoryNode[];
  readonly #byPath = new Map<VirtualPath, ExplorerNode>();

  constructor(configRoots: readonly EmulatedNodeConfig[]) {
    this.#roots = configRoots.map((node) => this.#toNode(node)).filter(isEmulatedDirectory);
    for (const root of this.#roots) this.#index(root);
  }

  async list(path: VirtualPath): Promise<readonly ExplorerNode[]> {
    if (path === '/') return this.#roots;
    const node = this.#byPath.get(path);
    return node?.kind === 'emulated-directory' ? node.children : [];
  }

  async stat(path: VirtualPath): Promise<FileStat | null> {
    const node = this.#byPath.get(path);
    if (node === undefined || node.kind !== 'emulated-file') return null;
    return {
      path,
      mimeType: node.mimeType,
      byteSize: node.displaySize ?? 0,
      modifiedAt: node.modifiedAt ?? new Date(0).toISOString(),
    };
  }

  async read(): Promise<ReadableFile> {
    throw new Error('Emulated documents are opened through their renderer, not as raw bytes.');
  }

  #toNode(config: EmulatedNodeConfig): EmulatedDirectoryNode | EmulatedFileNode {
    const path = createVirtualPath(config.path);
    const base = {
      id: `emulated:${path}`,
      name: config.name,
      path,
      ...(config.modifiedAt === undefined ? {} : { modifiedAt: config.modifiedAt }),
      ...(config.iconHint === undefined ? {} : { iconHint: toIconHint(config.iconHint) }),
      ...(config.tags === undefined ? {} : { tags: config.tags }),
    };
    if (config.kind === 'directory') {
      return {
        ...base,
        kind: 'emulated-directory',
        children: (config.children ?? []).map((child) => this.#toNode(child)),
        ...(config.presentationProfileId === undefined
          ? {}
          : { presentationProfileId: config.presentationProfileId }),
      };
    }
    if (
      config.content === undefined ||
      config.mimeType === undefined ||
      config.size === undefined
    ) {
      throw new Error(`Emulated file is incomplete: ${config.path}`);
    }
    return {
      ...base,
      kind: 'emulated-file',
      mimeType: config.mimeType,
      displaySize: config.size,
      emulation: config.content,
    };
  }

  #index(node: ExplorerNode): void {
    this.#byPath.set(node.path, node);
    if (node.kind === 'emulated-directory') {
      for (const child of node.children) this.#index(child);
    }
  }
}

function isEmulatedDirectory(node: ExplorerNode): node is EmulatedDirectoryNode {
  return node.kind === 'emulated-directory';
}

function toIconHint(value: string) {
  const allowed = [
    'folder',
    'document',
    'photo',
    'video',
    'audio',
    'map',
    'graph',
    'case',
  ] as const;
  return allowed.find((candidate) => candidate === value) ?? 'document';
}
