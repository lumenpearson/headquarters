import { invoke, isTauri } from '@tauri-apps/api/core';
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

interface NativeRoot {
  readonly index: number;
  readonly label: string;
}
interface NativeEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly byteSize: number | null;
  readonly modifiedAtMs: number | null;
}

export class TauriFileSource implements FileSourcePort {
  readonly id = 'tauri';
  readonly label = 'TAURI / NATIVE';
  readonly #roots = new Map<string, NativeRoot>();
  readonly #files = new Map<
    VirtualPath,
    { readonly node: RealFileNode; readonly rootIndex: number; readonly relativePath: string }
  >();

  async list(path: VirtualPath): Promise<readonly ExplorerNode[]> {
    if (!isTauri()) throw new Error('Tauri runtime is unavailable.');
    if (path === '/') {
      const roots = await invoke<readonly NativeRoot[]>('list_native_roots');
      return roots.map((root) => {
        const segment = `LOCAL-${root.index}`;
        this.#roots.set(segment, root);
        return {
          id: `${this.id}:${segment}`,
          kind: 'mount' as const,
          sourceId: this.id,
          name: root.label,
          path: createVirtualPath(`/${segment}`),
          status: 'online' as const,
          iconHint: 'folder' as const,
        };
      });
    }
    const segments = getVirtualPathSegments(path);
    const rootSegment = segments[0];
    if (rootSegment === undefined) return [];
    const root = this.#roots.get(rootSegment);
    if (root === undefined) throw new Error('Native root is not registered in this session.');
    const relativePath = segments.slice(1).join('/');
    const entries = await invoke<readonly NativeEntry[]>('list_directory', {
      rootIndex: root.index,
      relativePath,
    });
    return entries.map((entry): ExplorerNode => {
      const childPath = joinVirtualPath(path, entry.name);
      if (entry.kind === 'directory')
        return {
          id: `${this.id}:${childPath}`,
          kind: 'real-directory',
          sourceId: this.id,
          name: entry.name,
          path: childPath,
          iconHint: 'folder',
        };
      const node: RealFileNode = {
        id: `${this.id}:${childPath}`,
        kind: 'real-file',
        sourceId: this.id,
        name: entry.name,
        path: childPath,
        mimeType: mimeFromName(entry.name),
        byteSize: entry.byteSize ?? 0,
        displaySize: entry.byteSize ?? 0,
        ...(entry.modifiedAtMs === null
          ? {}
          : { modifiedAt: new Date(entry.modifiedAtMs).toISOString() }),
      };
      this.#files.set(childPath, { node, rootIndex: root.index, relativePath: entry.relativePath });
      return node;
    });
  }

  async stat(path: VirtualPath): Promise<FileStat | null> {
    const entry = this.#files.get(path);
    if (entry === undefined) return null;
    return {
      path,
      mimeType: entry.node.mimeType,
      byteSize: entry.node.byteSize,
      modifiedAt: entry.node.modifiedAt ?? new Date(0).toISOString(),
    };
  }

  async read(path: VirtualPath): Promise<ReadableFile> {
    const entry = this.#files.get(path);
    if (entry === undefined) throw new Error(`Native file was not listed: ${path}`);
    const bytes = await invoke<number[]>('read_file', {
      rootIndex: entry.rootIndex,
      relativePath: entry.relativePath,
    });
    return { node: entry.node, content: { kind: 'bytes', bytes: Uint8Array.from(bytes) } };
  }
}

function mimeFromName(name: string): string {
  const extension = name.split('.').pop()?.toLocaleLowerCase('en-US');
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'txt') return 'text/plain';
  return 'application/octet-stream';
}
