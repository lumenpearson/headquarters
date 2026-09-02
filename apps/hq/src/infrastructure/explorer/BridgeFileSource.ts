import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import {
  BridgeFailure,
  BridgeFailureDetailSchema,
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

/** One registered listener for one directory, held while its stream is live. */
interface BridgeWatcher {
  readonly path: VirtualPath;
  readonly listener: FileSourceListener;
}

/**
 * What the operator is shown a caption for when the bridge refuses.
 *
 * Twenty-four members mirror `gremuchaya.bridge.v1.BridgeFailure` one for one;
 * the remaining five describe the transport rather than a decision the bridge
 * took. `'unknown'` is the degradation target and must never be removed: a
 * bridge newer than this build sends codes that are not in this union, and the
 * alternative to landing on `'unknown'` is landing on `undefined`.
 */
export type BridgeErrorCode =
  // Coded by the bridge.
  | 'internal'
  | 'missing-field'
  | 'path-escapes-mount'
  | 'symlink-refused'
  | 'internal-path-hidden'
  | 'mount-unknown'
  | 'not-a-directory'
  | 'not-a-file'
  | 'entry-not-found'
  | 'material-import-disabled'
  | 'material-too-large'
  | 'material-name-unsafe'
  | 'material-chunk-rejected'
  | 'material-upload-incomplete'
  | 'material-hash-mismatch'
  | 'material-session-not-found'
  | 'material-not-found'
  | 'material-record-unreadable'
  | 'material-mount-unavailable'
  | 'playback-unsupported-media'
  | 'playback-capacity-reached'
  | 'playback-unavailable'
  | 'material-request-invalid'
  | 'path-rejected'
  // Read off the transport, for failures the bridge never decided.
  | 'canceled'
  | 'deadline-exceeded'
  | 'unavailable'
  | 'unimplemented'
  | 'unknown';

/**
 * The coarse grouping, for a caller that has to branch rather than caption.
 *
 * Named to match `ControlPlaneErrorKind` so the two adapters read the same way,
 * even though the bridge's callers use far less of it: nothing in the explorer
 * retries or re-authenticates, so today this only separates "the bridge is not
 * there" from "the bridge said no".
 */
export type BridgeErrorKind =
  | 'permission-denied'
  | 'not-found'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'unavailable'
  | 'unknown';

/** Total over the code union, so a code added without a kind fails to compile. */
const bridgeErrorKinds: Readonly<Record<BridgeErrorCode, BridgeErrorKind>> = {
  internal: 'unknown',
  'missing-field': 'invalid-argument',
  'path-escapes-mount': 'permission-denied',
  'symlink-refused': 'permission-denied',
  'internal-path-hidden': 'permission-denied',
  'mount-unknown': 'not-found',
  'not-a-directory': 'invalid-argument',
  'not-a-file': 'invalid-argument',
  'entry-not-found': 'not-found',
  'material-import-disabled': 'failed-precondition',
  'material-too-large': 'invalid-argument',
  'material-name-unsafe': 'invalid-argument',
  'material-chunk-rejected': 'invalid-argument',
  'material-upload-incomplete': 'failed-precondition',
  'material-hash-mismatch': 'invalid-argument',
  'material-session-not-found': 'not-found',
  'material-not-found': 'not-found',
  'material-record-unreadable': 'failed-precondition',
  'material-mount-unavailable': 'failed-precondition',
  'playback-unsupported-media': 'invalid-argument',
  'playback-capacity-reached': 'failed-precondition',
  'playback-unavailable': 'failed-precondition',
  'material-request-invalid': 'invalid-argument',
  'path-rejected': 'permission-denied',
  canceled: 'unavailable',
  'deadline-exceeded': 'unavailable',
  unavailable: 'unavailable',
  unimplemented: 'unknown',
  unknown: 'unknown',
};

/** What each wire code is called on this side. Total over `BridgeFailure`. */
const wireFailureCodes: Readonly<
  Record<Exclude<BridgeFailure, BridgeFailure.UNSPECIFIED>, BridgeErrorCode>
> = {
  [BridgeFailure.INTERNAL]: 'internal',
  [BridgeFailure.MISSING_FIELD]: 'missing-field',
  [BridgeFailure.PATH_ESCAPES_MOUNT]: 'path-escapes-mount',
  [BridgeFailure.SYMLINK_REFUSED]: 'symlink-refused',
  [BridgeFailure.INTERNAL_PATH_HIDDEN]: 'internal-path-hidden',
  [BridgeFailure.MOUNT_UNKNOWN]: 'mount-unknown',
  [BridgeFailure.NOT_A_DIRECTORY]: 'not-a-directory',
  [BridgeFailure.NOT_A_FILE]: 'not-a-file',
  [BridgeFailure.ENTRY_NOT_FOUND]: 'entry-not-found',
  [BridgeFailure.MATERIAL_IMPORT_DISABLED]: 'material-import-disabled',
  [BridgeFailure.MATERIAL_TOO_LARGE]: 'material-too-large',
  [BridgeFailure.MATERIAL_NAME_UNSAFE]: 'material-name-unsafe',
  [BridgeFailure.MATERIAL_CHUNK_REJECTED]: 'material-chunk-rejected',
  [BridgeFailure.MATERIAL_UPLOAD_INCOMPLETE]: 'material-upload-incomplete',
  [BridgeFailure.MATERIAL_HASH_MISMATCH]: 'material-hash-mismatch',
  [BridgeFailure.MATERIAL_SESSION_NOT_FOUND]: 'material-session-not-found',
  [BridgeFailure.MATERIAL_NOT_FOUND]: 'material-not-found',
  [BridgeFailure.MATERIAL_RECORD_UNREADABLE]: 'material-record-unreadable',
  [BridgeFailure.MATERIAL_MOUNT_UNAVAILABLE]: 'material-mount-unavailable',
  [BridgeFailure.PLAYBACK_UNSUPPORTED_MEDIA]: 'playback-unsupported-media',
  [BridgeFailure.PLAYBACK_CAPACITY_REACHED]: 'playback-capacity-reached',
  [BridgeFailure.PLAYBACK_UNAVAILABLE]: 'playback-unavailable',
  [BridgeFailure.MATERIAL_REQUEST_INVALID]: 'material-request-invalid',
  [BridgeFailure.PATH_REJECTED]: 'path-rejected',
};

/**
 * A `Map` rather than an index into the record above, because a lookup by a
 * number this build has never seen must answer `undefined` and not throw.
 */
const wireFailureCodesByValue = new Map<number, BridgeErrorCode>(
  Object.entries(wireFailureCodes).map(([value, code]) => [Number(value), code]),
);

/** What a transport status means when the bridge attached no code. */
const transportFailureCodes: Readonly<Record<Code, BridgeErrorCode>> = {
  [Code.Canceled]: 'canceled',
  [Code.Unknown]: 'unknown',
  [Code.InvalidArgument]: 'missing-field',
  [Code.DeadlineExceeded]: 'deadline-exceeded',
  [Code.NotFound]: 'entry-not-found',
  [Code.AlreadyExists]: 'unknown',
  [Code.PermissionDenied]: 'path-escapes-mount',
  [Code.ResourceExhausted]: 'playback-capacity-reached',
  [Code.FailedPrecondition]: 'unknown',
  [Code.Aborted]: 'unknown',
  [Code.OutOfRange]: 'unknown',
  [Code.Unimplemented]: 'unimplemented',
  [Code.Internal]: 'internal',
  [Code.Unavailable]: 'unavailable',
  [Code.DataLoss]: 'internal',
  [Code.Unauthenticated]: 'unknown',
};

/**
 * A bridge refusal as this application reasons about it.
 *
 * `message` is developer-facing English from the bridge and is not for display:
 * it belongs in the diagnostics copy, it has no translation, and the caption an
 * operator reads is chosen by `code`. `FilesScreen.messageFromBridgeError`
 * currently prints it, which is what a later wave replaces with a catalogue
 * lookup on `code`.
 */
export class BridgeFileError extends Error {
  readonly kind: BridgeErrorKind;

  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BridgeFileError';
    this.kind = bridgeErrorKinds[code];
  }
}

/**
 * Turns anything a bridge call throws into a coded failure.
 *
 * Exported because `BridgeMaterialClient` makes the other half of this
 * application's bridge calls and needs exactly this classification; it is
 * declared here, beside the vocabulary, rather than duplicated there.
 *
 * Nothing in here may throw. It runs while an error is already being handled,
 * on a path that ends at a screen an operator is watching during a take.
 * `findDetails` drops a detail it cannot decode rather than raising, an
 * unrecognised code number misses the map and falls through, and the transport
 * table is backed by `?? 'unknown'` for a status outside `Code`.
 */
export function toBridgeFileError(error: unknown): BridgeFileError {
  if (error instanceof BridgeFileError) return error;
  if (error instanceof ConnectError) {
    const [detail] = error.findDetails(BridgeFailureDetailSchema);
    const declared = detail === undefined ? undefined : wireFailureCodesByValue.get(detail.code);
    const code = declared ?? transportFailureCodes[error.code] ?? 'unknown';
    return new BridgeFileError(code, error.rawMessage, { cause: error });
  }
  // A fetch that never reached the loopback port arrives as a plain error, which
  // is the ordinary state of a bridge that is not running.
  return new BridgeFileError(
    'unavailable',
    error instanceof Error ? error.message : 'File bridge unreachable.',
    { cause: error },
  );
}

export class BridgeFileSource implements FileSourcePort {
  readonly id = 'file-bridge';
  readonly label = 'GRPC FILE BRIDGE';
  readonly #files = new Map<VirtualPath, RealFileNode>();
  readonly #client: Client<typeof FileBridgeService>;
  readonly #watchClient: BridgeWatchClient;
  readonly #watchers = new Set<BridgeWatcher>();
  /** The one live `Watch` stream all of `#watchers` share, if any is open. */
  #stream: { readonly controller: AbortController } | null = null;

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
    return call(() => this.#client.health({}, signal === undefined ? {} : { signal }));
  }

  async list(path: VirtualPath, signal?: AbortSignal): Promise<readonly ExplorerNode[]> {
    const response = await call(() =>
      this.#client.list({ mountId: this.mountId, path }, signal === undefined ? {} : { signal }),
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
    if (node === undefined) {
      throw new BridgeFileError('entry-not-found', `Bridge file was not listed: ${path}`);
    }
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    // The stream is coded chunk by chunk: a `ReadFile` that fails after its
    // first message rejects here, not at the call, so a `try` around the call
    // alone would let the raw refusal through.
    const stream = this.#client.readFile(
      { mountId: this.mountId, path: createVirtualPath(path) },
      signal === undefined ? {} : { signal },
    );
    for await (const chunk of coded(stream)) {
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
   * Every watcher on this mount shares one `Watch` stream instead of opening
   * its own: `WatchRequest` already names a mount, not a directory, so a
   * second watch of the same mount was duplicating an identical RPC and its
   * wire traffic. The stream opens on the first `watch()` and stays live
   * while `#watchers` is non-empty; the `dispose()` that empties it is what
   * aborts the stream, and the next `watch()` after that opens a fresh one --
   * this never reopens on its own. Two consequences follow: a watcher that
   * survives its stream ending goes deaf until another `watch()` call is
   * made (acceptable because the only consumer, `RuntimeController`,
   * re-watches on every navigation), and one transport failure now stops
   * every watcher on this mount at once -- structural, but was already the
   * whole watch in practice, since `RuntimeController` never holds more than
   * one open.
   *
   * The stream is pumped detached from this call: the RPC has no first message
   * to wait for, and a watch that only started once an event arrived would
   * report nothing until something moved.
   */
  async watch(path: VirtualPath, listener: FileSourceListener): Promise<Disposable> {
    const watcher: BridgeWatcher = { path, listener };
    this.#watchers.add(watcher);
    if (this.#stream === null) {
      const controller = new AbortController();
      this.#stream = { controller };
      const stream = this.#watchClient.watch(
        { mountIds: [this.mountId] },
        { signal: controller.signal },
      );
      void this.#pump(stream, controller.signal);
    }
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#watchers.delete(watcher);
        if (this.#watchers.size > 0) return;
        // Aborting is what ends the RPC, on both sides: the cancellation
        // reaches the server's `watch` as its own context signal, which is
        // what `BridgeEventHub.subscribe` drops its subscriber on.
        this.#stream?.controller.abort();
        this.#stream = null;
      },
    };
  }

  async #pump(stream: AsyncIterable<WatchResponse>, signal: AbortSignal): Promise<void> {
    try {
      for await (const response of stream) {
        // A response already in flight when the last watcher disposed must
        // not reach listeners the caller has finished with.
        if (signal.aborted) return;
        for (const watcher of this.#watchers) {
          const event = this.#toFileSourceEvent(response, watcher.path);
          if (event === null) continue;
          try {
            watcher.listener(event);
          } catch {
            // No error channel on the port, and multiplexing means this
            // listener is one of several sharing the mount's stream: before,
            // a throw here only cost its own stream; now it must not kill the
            // stream for every other watcher too.
          }
        }
      }
    } catch {
      // Both endings arrive as a throw: `Code.Canceled` for the abort the last
      // `dispose` asked for, a transport error when the bridge goes away.
      // Neither can be reported -- `FileSourcePort.watch` gives the listener no
      // error channel and this runs detached from every caller, where a
      // re-throw would surface as an unhandled rejection. The watch stops.
    } finally {
      // This never reopens the stream, and does not make `watch()` race-free:
      // `watch()` decides liveness solely by `#stream === null`, and this
      // `finally` can land turns after the stream actually died, not before
      // it. A `watch()` call in that window joins the dying stream and is
      // left deaf once this runs -- the same degradation any transport death
      // produces, bounded by the only consumer, `RuntimeController`,
      // re-watching on every navigation. The identity check below does not
      // narrow that window; it only stops a *late* teardown from nulling a
      // *different*, newer stream a later `watch()` has since opened, which
      // would otherwise leave that stream leaked past its own last dispose
      // and open the door to two live streams fanning out to one `#watchers`
      // set. `#watchers` itself is left untouched either way.
      if (this.#stream !== null && this.#stream.controller.signal === signal) {
        this.#stream = null;
      }
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

async function call<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw toBridgeFileError(error);
  }
}

async function* coded<Value>(stream: AsyncIterable<Value>): AsyncIterable<Value> {
  try {
    yield* stream;
  } catch (error: unknown) {
    throw toBridgeFileError(error);
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
