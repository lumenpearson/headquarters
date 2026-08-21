import {
  createVirtualPath,
  getVirtualPathSegments,
  joinVirtualPath,
  type ExplorerNode,
  type FileSourcePort,
  type FileStat,
  type ReadableFile,
  type RealFileNode,
  type VirtualPath,
} from '@gremuchaya/domain';

export class BrowserDirectorySource implements FileSourcePort {
  readonly id = 'browser-directory';
  readonly label = 'ЛОКАЛЬНАЯ ПАПКА';
  #root: FileSystemDirectoryHandle | null = null;
  readonly #files = new Map<VirtualPath, FileSystemFileHandle>();

  get connected(): boolean {
    return this.#root !== null;
  }

  async connect(): Promise<void> {
    const picker = window.showDirectoryPicker;
    if (picker === undefined)
      throw new Error('File System Access API is unavailable in this browser.');
    this.#root = await picker({ mode: 'read' });
    this.#files.clear();
  }

  async list(path: VirtualPath, signal?: AbortSignal): Promise<readonly ExplorerNode[]> {
    const directory = await this.#directoryAt(path);
    const nodes: ExplorerNode[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (signal?.aborted === true) break;
      const childPath = joinVirtualPath(path, name);
      if (handle.kind === 'directory') {
        nodes.push({
          id: `${this.id}:${childPath}`,
          kind: 'real-directory',
          sourceId: this.id,
          name,
          path: childPath,
          iconHint: 'folder',
        });
      } else {
        const file = await handle.getFile();
        this.#files.set(childPath, handle);
        nodes.push(toFileNode(this.id, childPath, file));
      }
    }
    return nodes;
  }

  async stat(path: VirtualPath): Promise<FileStat | null> {
    const handle = this.#files.get(path);
    if (handle === undefined) return null;
    const file = await handle.getFile();
    return {
      path,
      mimeType: file.type || 'application/octet-stream',
      byteSize: file.size,
      modifiedAt: new Date(file.lastModified).toISOString(),
    };
  }

  async read(path: VirtualPath): Promise<ReadableFile> {
    const handle = this.#files.get(path);
    if (handle === undefined) throw new Error(`File was not listed before read: ${path}`);
    const file = await handle.getFile();
    const node = toFileNode(this.id, path, file);
    if (file.type.startsWith('text/') || file.size <= 1024 * 1024) {
      return { node, content: { kind: 'text', text: await file.text() } };
    }
    return { node, content: { kind: 'url', url: URL.createObjectURL(file) } };
  }

  async #directoryAt(path: VirtualPath): Promise<FileSystemDirectoryHandle> {
    if (this.#root === null) throw new Error('No browser directory has been connected.');
    let handle = this.#root;
    for (const segment of getVirtualPathSegments(path)) {
      handle = await handle.getDirectoryHandle(segment);
    }
    return handle;
  }
}

function toFileNode(sourceId: string, path: VirtualPath, file: File): RealFileNode {
  const iconHint = iconForMime(file.type);
  return {
    id: `${sourceId}:${path}`,
    kind: 'real-file',
    sourceId,
    name: file.name,
    path: createVirtualPath(path),
    mimeType: file.type || 'application/octet-stream',
    byteSize: file.size,
    displaySize: file.size,
    modifiedAt: new Date(file.lastModified).toISOString(),
    ...(iconHint === undefined ? {} : { iconHint }),
  };
}

function iconForMime(mimeType: string): RealFileNode['iconHint'] {
  if (mimeType.startsWith('image/')) return 'photo';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}
