import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { EntryKind, FileBridgeService } from '@gremuchaya/protocol';
import {
  createVirtualPath,
  type ExplorerNode,
  type FileSourcePort,
  type FileStat,
  type ReadableFile,
  type RealFileNode,
  type VirtualPath,
} from '@gremuchaya/domain';

export class BridgeFileSource implements FileSourcePort {
  readonly id = 'file-bridge';
  readonly label = 'GRPC FILE BRIDGE';
  readonly #files = new Map<VirtualPath, RealFileNode>();
  readonly #client: Client<typeof FileBridgeService>;

  constructor(
    baseUrl: string,
    private readonly mountId = 'incoming',
  ) {
    this.#client = createClient(
      FileBridgeService,
      createGrpcWebTransport({
        baseUrl,
        useBinaryFormat: true,
      }),
    );
  }

  async health(signal?: AbortSignal) {
    return this.#client.health({}, signal === undefined ? {} : { signal });
  }

  async list(path: VirtualPath, signal?: AbortSignal): Promise<readonly ExplorerNode[]> {
    const response = await this.#client.list(
      { mountId: this.mountId, path },
      signal === undefined ? {} : { signal },
    );
    return response.entries.map((entry): ExplorerNode => {
      const virtualPath = createVirtualPath(entry.path);
      if (entry.kind === EntryKind.DIRECTORY) {
        return {
          id: `${this.id}:${virtualPath}`,
          kind: 'real-directory',
          sourceId: this.id,
          name: entry.name,
          path: virtualPath,
          modifiedAt: entry.modifiedAt,
          iconHint: 'folder',
        };
      }
      const node: RealFileNode = {
        id: `${this.id}:${virtualPath}`,
        kind: 'real-file',
        sourceId: this.id,
        name: entry.name,
        path: virtualPath,
        modifiedAt: entry.modifiedAt,
        mimeType: entry.mimeType || 'application/octet-stream',
        byteSize: Number(entry.byteSize),
        displaySize: Number(entry.byteSize),
      };
      this.#files.set(virtualPath, node);
      return node;
    });
  }

  async stat(path: VirtualPath, signal?: AbortSignal): Promise<FileStat | null> {
    const node = this.#files.get(path);
    if (node === undefined) return null;
    if (signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
    return {
      path,
      mimeType: node.mimeType,
      byteSize: node.byteSize,
      modifiedAt: node.modifiedAt ?? new Date(0).toISOString(),
    };
  }

  async read(path: VirtualPath, signal?: AbortSignal): Promise<ReadableFile> {
    const node = this.#files.get(path);
    if (node === undefined) throw new Error(`Bridge file was not listed: ${path}`);
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    for await (const chunk of this.#client.readFile(
      { mountId: this.mountId, path: createVirtualPath(path) },
      signal === undefined ? {} : { signal },
    )) {
      chunks.push(chunk.data);
      totalLength += chunk.data.byteLength;
    }
    const bytes = concatenateChunks(chunks, totalLength);
    if (node.mimeType.startsWith('text/')) {
      return { node, content: { kind: 'text', text: new TextDecoder().decode(bytes) } };
    }
    return { node, content: { kind: 'bytes', bytes } };
  }
}

function concatenateChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const value = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}
