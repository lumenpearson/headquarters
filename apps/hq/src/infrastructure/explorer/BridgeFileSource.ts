import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import {
  EntryKind,
  FileBridgeService,
  FileEventKind,
  type WatchResponse,
} from '@gremuchaya/protocol';
import {
  createVirtualPath,
  type Disposable,
  type ExplorerNode,
  type FileSourceEvent,
  type FileSourceListener,
  type FileSourcePort,
  type FileStat,
  type ReadableFile,
  type RealFileNode,
  type VirtualPath,
} from '@gremuchaya/domain';

/**
 * The streaming half of `FileBridgeService`, named so a test can drive the
 * watch mapping from a fake stream instead of a socket -- the same seam
 * `ControlPlaneClient` opens for its own clients.
 */
export type BridgeWatchClient = Pick<Client<typeof FileBridgeService>, 'watch'>;

/** How each wire kind names itself in the domain's file-source union. */
const watchEventTypes: Readonly<Record<FileEventKind, FileSourceEvent['type'] | null>> = {
  // The zero value is what an unset field decodes to, which names no event.
  [FileEventKind.UNSPECIFIED]: null,
  [FileEventKind.ADDED]: 'FILE_ADDED',
  [FileEventKind.CHANGED]: 'FILE_CHANGED',
  [FileEventKind.REMOVED]: 'FILE_REMOVED',
  [FileEventKind.DIRECTORY_CHANGED]: 'DIRECTORY_CHANGED',
  [FileEventKind.READY]: 'FILE_READY',
};

export class BridgeFileSource implements FileSourcePort {
  readonly id = 'file-bridge';
  readonly label = 'GRPC FILE BRIDGE';
  readonly #files = new Map<VirtualPath, RealFileNode>();
  readonly #client: Client<typeof FileBridgeService>;
  readonly #watchClient: BridgeWatchClient;

  constructor(
    baseUrl: string,
    private readonly mountId = 'incoming',
    watchClient?: BridgeWatchClient,
  ) {
    this.#client = createClient(
      FileBridgeService,
      createGrpcWebTransport({
        baseUrl,
        useBinaryFormat: true,
      }),
    );
    this.#watchClient = watchClient ?? this.#client;
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

  /**
   * Subscribes to the bridge's watcher for one directory and everything below.
   *
   * This is the second implementation of the domain's optional
   * `FileSourcePort.watch`, after `TauriFileSource`. `Watch` subscribes per
   * mount rather than per directory -- one stream carries the whole mount --
   * so the subtree filter is applied here, which leaves both adapters
   * answering for a directory and its descendants.
   *
   * The stream is pumped detached from this call: the RPC has no first message
   * to wait for, and a watch that only started once an event arrived would
   * report nothing until something moved.
   */
  async watch(path: VirtualPath, listener: FileSourceListener): Promise<Disposable> {
    const controller = new AbortController();
    const stream = this.#watchClient.watch(
      { mountIds: [this.mountId] },
      { signal: controller.signal },
    );
    void this.#pump(stream, path, listener, controller.signal);
    return {
      dispose: () => {
        // Aborting is what ends the RPC, on both sides: the cancellation
        // reaches the server's `watch` as its own context signal, which is
        // what `BridgeEventHub.subscribe` drops its subscriber on.
        controller.abort();
      },
    };
  }

  async #pump(
    stream: AsyncIterable<WatchResponse>,
    path: VirtualPath,
    listener: FileSourceListener,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const response of stream) {
        // A response already in flight when `dispose` ran must not reach a
        // listener the caller has finished with.
        if (signal.aborted) return;
        const event = this.#toFileSourceEvent(response, path);
        if (event !== null) listener(event);
      }
    } catch {
      // Both endings arrive as a throw: `Code.Canceled` for the abort `dispose`
      // asked for, a transport error when the bridge goes away. Neither can be
      // reported -- `FileSourcePort.watch` gives the listener no error channel
      // and this runs detached from the caller, where a re-throw would surface
      // as an unhandled rejection. The watch stops.
    }
  }

  /** Maps one `WatchResponse` onto the domain's union, or drops it. */
  #toFileSourceEvent(response: WatchResponse, watched: VirtualPath): FileSourceEvent | null {
    // The mount filter lives on the server; an event for another mount would
    // name a path in a tree this source does not project.
    if (response.mountId !== this.mountId) return null;
    // Proto3 enums are open: a kind added after this build arrives as its own
    // number and misses the table, which is the same answer as unspecified.
    const type = watchEventTypes[response.kind] ?? null;
    if (type === null) return null;
    const path = toVirtualPath(response.path);
    if (path === null || !isWithin(watched, path)) return null;
    return { type, sourceId: this.id, path };
  }
}

/** Whether an event names the watched directory itself or something under it. */
function isWithin(watched: VirtualPath, candidate: VirtualPath): boolean {
  if (watched === '/') return true;
  return candidate === watched || candidate.startsWith(`${watched}/`);
}

/**
 * Brands a path that arrived on the stream, or drops it.
 *
 * `createVirtualPath` throws on a name it cannot represent (a NUL byte, an
 * over-long path). This runs inside the pump, where the caller cannot catch
 * anything, so one unrepresentable name must not end the whole watch.
 */
function toVirtualPath(value: string): VirtualPath | null {
  try {
    return createVirtualPath(value);
  } catch {
    return null;
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
