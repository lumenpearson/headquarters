import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { realtimeV1 } from '@gremuchaya/protocol';
import type { syncV1 } from '@gremuchaya/protocol';

import type { RealtimeLinkState } from '@/application/sync/connection';
import type {
  GroupEventCursor,
  GroupEventEnvelope,
  RealtimeIdentity,
} from '@/application/sync/groupChannel';

import { toGroupEventEnvelope } from './groupEventCodec';

/** The path `attachRealtimeTransport` listens on. Nothing else is served there. */
const realtimePath = '/realtime';

/**
 * The frame ceiling the server enforces with `maxPayload`. A larger frame is
 * dropped by the socket before this client sees it, so an oversized hello is
 * refused here instead of silently disappearing.
 */
const maxFrameBytes = 64 * 1024;

/** How often a live socket proves itself. Well inside the server's 15 s recheck. */
const defaultPingIntervalMs = 10_000;

/**
 * Bounded backoff. Five steps and then the last one repeats: a control plane
 * that has been down for a minute is being restarted or is gone, and a client
 * hammering it every half second helps neither.
 */
const defaultBackoffMs: readonly number[] = [500, 1_000, 2_000, 5_000, 15_000];

/** A normal close. `1008` is the server's policy violation and is never ours. */
const normalCloseCode = 1000;

/**
 * The part of `WebSocket` this client uses, so a test can hand in a fake.
 *
 * Written as the event-handler properties rather than `addEventListener`
 * because those are what a hand-written double implements in three lines, and
 * this client registers exactly one handler for each.
 */
export interface RealtimeSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export type RealtimeSocketFactory = (url: string) => RealtimeSocketLike;

/** The three answers a `ResyncRequired` can end in. */
export interface RealtimeResyncOutcome {
  /** The sequence the next hello resumes from. */
  readonly afterSequence: bigint;
}

export interface RealtimeClientOptions {
  /**
   * The control plane's base address -- the same one the RPC transport uses.
   * The socket URL is derived from it; the token is never part of either.
   */
  readonly baseUrl: string;
  /**
   * Group, device and access token, read at the moment a socket opens rather
   * than captured once, so a reconnect after a refresh carries the rotated
   * token. `null` means there is nothing to connect with and the client waits.
   */
  readonly identity: () => RealtimeIdentity | null;
  readonly onEvent: (event: GroupEventEnvelope) => void;
  readonly onStatus: (state: RealtimeLinkState) => void;
  /**
   * The group's applied position, owned by whatever merges the transports.
   *
   * The socket resumes from it and rewinds it on a resync, but does not own
   * it: a group fed by both a socket and a poller has one order and therefore
   * one position. Absent, the client keeps a private cursor, which is what a
   * socket that is the only transport wants.
   */
  readonly cursor?: GroupEventCursor;
  /**
   * Called when the retained log no longer covers the resume point. The caller
   * takes `GetDocumentSnapshot` and answers with the sequence the snapshot was
   * taken at; the next hello resumes from there.
   */
  readonly onResync?: (
    resync: {
      readonly requestedAfterSequence: bigint;
      readonly earliestAvailableSequence: bigint;
    },
    signal: AbortSignal,
  ) => Promise<RealtimeResyncOutcome | null>;
  /**
   * Called when the server refuses the credentials -- `realtime.unauthenticated`
   * on a hello, or `realtime.reauthentication_required` on an admitted socket.
   * The session service refreshes and the client is started again; retrying on
   * our own with the same dead token would be a loop.
   */
  readonly onReauthenticationRequired?: () => void;
  readonly createSocket?: RealtimeSocketFactory;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly backoffMs?: readonly number[];
  readonly pingIntervalMs?: number;
  /**
   * The round trip of one ping, in milliseconds, once its pong has answered.
   *
   * Beside `pingIntervalMs` because the two describe one exchange: the interval
   * decides how often a sample is taken and this is where the sample goes.
   * Absent, the pings are still sent -- they are what proves the socket to the
   * server -- and nothing is measured.
   */
  readonly onLatencySample?: (roundTripMs: number) => void;
  readonly now?: () => number;
}

/**
 * The group's realtime socket (R27, F10 task 2).
 *
 * Binary Protobuf frames on `/realtime`, which is the only shape the server
 * accepts: a text frame is answered `realtime.binary_required`. The client
 * says hello once per socket -- a second hello on the same one is
 * `realtime.duplicate_hello` -- so a resume that the retained log cannot
 * answer is served by closing and dialling again from the snapshot's
 * sequence rather than by re-greeting.
 *
 * The access token travels in the hello frame body and nowhere else. Browsers
 * cannot set an `Authorization` header on a WebSocket, and the alternative --
 * a query parameter -- would put a bearer credential into every proxy log and
 * every browser history entry between here and the control plane. The URL this
 * client builds carries the path and nothing more.
 */
export class RealtimeClient {
  readonly #options: RealtimeClientOptions;
  readonly #url: string;
  readonly #createSocket: RealtimeSocketFactory;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #backoffMs: readonly number[];
  readonly #pingIntervalMs: number;
  readonly #now: () => number;
  #socket: RealtimeSocketLike | null = null;
  #cancelReconnect: (() => void) | null = null;
  #cancelPing: (() => void) | null = null;
  #resyncController: AbortController | null = null;
  #attempt = 0;
  #started = false;
  /**
   * The group's applied position. Injected when something else merges the
   * transports; private when this socket is the only one.
   */
  readonly #cursor: GroupEventCursor;
  /**
   * Whether this socket is the group's merge point.
   *
   * True when no cursor was injected, which means nothing else is feeding the
   * group and the socket both decides what is new and remembers it. False when
   * a channel merges several transports: then the channel decides, and a
   * socket that also decided would advance the position past an event the
   * channel had not yet fanned out.
   */
  readonly #ownsCursor: boolean;
  #connectionId = '';
  #resyncCount = 0;
  #status: RealtimeLinkState['status'] = 'off';

  constructor(options: RealtimeClientOptions) {
    this.#options = options;
    this.#cursor = options.cursor ?? createPrivateCursor();
    this.#ownsCursor = options.cursor === undefined;
    this.#url = realtimeUrl(options.baseUrl);
    this.#createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as RealtimeSocketLike);
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timeoutId = setTimeout(callback, delayMs);
        return () => clearTimeout(timeoutId);
      });
    this.#backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.#pingIntervalMs = options.pingIntervalMs ?? defaultPingIntervalMs;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The socket address, path only. Exposed so a test can assert what it is not. */
  get url(): string {
    return this.#url;
  }

  get lastSequence(): bigint {
    return this.#cursor.appliedSequence();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#attempt = 0;
    this.#open();
  }

  /**
   * Closes the socket for good and cancels every timer it owns.
   *
   * Idempotent, because it is a React effect cleanup: the same runtime may
   * stop a client that a failed connect already tore down.
   */
  stop(): void {
    this.#started = false;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#cancelPing?.();
    this.#cancelPing = null;
    this.#resyncController?.abort();
    this.#resyncController = null;
    this.#detach(this.#socket);
    this.#socket?.close(normalCloseCode, 'client stopped');
    this.#socket = null;
    this.#connectionId = '';
    this.#emit('off');
  }

  #open(): void {
    const identity = this.#options.identity();
    if (identity === null) {
      // Nothing to greet the server with. The session service will start this
      // client again once it has a session; a socket opened without one would
      // be closed by the server on the first hello anyway.
      this.#emit('off');
      return;
    }
    this.#emit('connecting');
    let socket: RealtimeSocketLike;
    try {
      socket = this.#createSocket(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#sendHello(socket, identity);
      this.#startPing(socket);
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      this.#receive(socket, event.data);
    };
    socket.onerror = () => {
      // `error` is always followed by `close` in the WebSocket lifecycle, and
      // the close is where the reconnect is decided. Handling both would
      // schedule two attempts for one drop.
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#detach(socket);
      this.#socket = null;
      this.#connectionId = '';
      this.#stopPing();
      if (!this.#started) {
        this.#emit('off');
        return;
      }
      this.#scheduleReconnect();
    };
  }

  #sendHello(socket: RealtimeSocketLike, identity: RealtimeIdentity): void {
    // `document_state_vector` is what a CRDT would use to ask for only the
    // updates it lacks. This client carries settings patches rather than a
    // CRDT document, so it sends the empty vector and resumes by sequence.
    const frame = create(realtimeV1.RealtimeClientFrameSchema, {
      payload: {
        case: 'hello',
        value: {
          groupId: { value: identity.groupId },
          deviceId: { value: identity.deviceId },
          afterSequence: this.#cursor.appliedSequence(),
          documentStateVector: identity.documentStateVector ?? new Uint8Array(0),
          accessToken: identity.accessToken,
        },
      },
    });
    this.#send(socket, realtimeV1.RealtimeClientFrameSchema, frame);
  }

  #receive(socket: RealtimeSocketLike, data: unknown): void {
    const bytes = toBytes(data);
    if (bytes === null) return;
    let frame: realtimeV1.RealtimeServerFrame;
    try {
      frame = fromBinary(realtimeV1.RealtimeServerFrameSchema, bytes);
    } catch {
      // A frame this build cannot decode is not a reason to drop the socket:
      // the server may be one contract version ahead, and every other frame
      // still applies.
      return;
    }
    switch (frame.payload.case) {
      case 'ready':
        this.#connectionId = frame.payload.value.connectionId;
        // A successful greeting is what resets the backoff, not a successful
        // connect: a socket the server closes on admission would otherwise
        // reconnect at full speed for ever.
        this.#attempt = 0;
        this.#emit('live');
        return;
      case 'groupEvent':
        this.#applyEvent(socket, frame.payload.value.event);
        return;
      case 'resyncRequired':
        this.#resync(socket, frame.payload.value);
        return;
      case 'pong':
        this.#measureRoundTrip(frame.payload.value);
        return;
      case 'error':
        this.#applyError(socket, frame.payload.value.code);
        return;
      default:
        return;
    }
  }

  /**
   * Applies one group event, newest-sequence-wins.
   *
   * An event at or below the last applied sequence is dropped rather than
   * delivered: a resume replays from `after_sequence` and the hub also flushes
   * whatever was published while the replay ran, so a client that reconnects
   * mid-publication sees the same event on both paths.
   */
  #applyEvent(socket: RealtimeSocketLike, event: syncV1.GroupEvent | undefined): void {
    if (event === undefined) return;
    if (this.#ownsCursor && !this.#cursor.accept(event.sequence)) return;
    this.#emit(this.#status === 'live' ? 'live' : this.#status);
    this.#options.onEvent(toGroupEventEnvelope(event));
    this.#acknowledge(socket, event.sequence);
  }

  #acknowledge(socket: RealtimeSocketLike, sequence: bigint): void {
    const identity = this.#options.identity();
    if (identity === null) return;
    const frame = create(realtimeV1.RealtimeClientFrameSchema, {
      payload: {
        case: 'ack',
        value: { groupId: { value: identity.groupId }, sequence },
      },
    });
    this.#send(socket, realtimeV1.RealtimeClientFrameSchema, frame);
  }

  /**
   * Takes a snapshot and dials again from where it was taken.
   *
   * The socket is closed rather than re-greeted, because the server answers a
   * second hello on one connection with `realtime.duplicate_hello`. Closing
   * first also means the snapshot cannot race a replayed event: nothing is
   * being delivered while it is in flight.
   */
  #resync(socket: RealtimeSocketLike, resync: realtimeV1.ResyncRequired): void {
    this.#resyncCount += 1;
    this.#detach(socket);
    this.#socket = null;
    this.#stopPing();
    socket.close(normalCloseCode, 'resync');
    const onResync = this.#options.onResync;
    if (onResync === undefined) {
      // Without a snapshot collaborator the honest resume point is the oldest
      // the server still retains: everything before it is gone either way.
      this.#cursor.rewindTo(maxSequence(0n, resync.earliestAvailableSequence - 1n));
      this.#emit('reconnecting');
      if (this.#started) this.#scheduleReconnect();
      return;
    }
    this.#emit('connecting');
    const controller = new AbortController();
    this.#resyncController = controller;
    void onResync(
      {
        requestedAfterSequence: resync.requestedAfterSequence,
        earliestAvailableSequence: resync.earliestAvailableSequence,
      },
      controller.signal,
    )
      .then((outcome) => {
        if (controller.signal.aborted) return;
        this.#cursor.rewindTo(
          outcome === null
            ? maxSequence(0n, resync.earliestAvailableSequence - 1n)
            : outcome.afterSequence,
        );
      })
      .catch(() => {
        // A snapshot that could not be read leaves the client where the log
        // still starts, which is the most it can honestly claim to have seen.
        if (!controller.signal.aborted) {
          this.#cursor.rewindTo(maxSequence(0n, resync.earliestAvailableSequence - 1n));
        }
      })
      .finally(() => {
        if (this.#resyncController === controller) this.#resyncController = null;
        if (controller.signal.aborted || !this.#started) return;
        this.#open();
      });
  }

  #applyError(socket: RealtimeSocketLike, code: string): void {
    if (code !== 'realtime.unauthenticated' && code !== 'realtime.reauthentication_required') {
      // Every other code names one frame, not the connection: the server keeps
      // the socket open and so does this client.
      return;
    }
    // The server closes with 1008 straight after. Stopping here rather than in
    // `onclose` is what keeps the backoff from dialling with the same refused
    // token: the session service refreshes and starts this client again.
    this.#started = false;
    this.#detach(socket);
    this.#socket = null;
    this.#stopPing();
    socket.close(normalCloseCode, 'reauthentication required');
    this.#connectionId = '';
    this.#emit('off');
    this.#options.onReauthenticationRequired?.();
  }

  #scheduleReconnect(): void {
    this.#cancelReconnect?.();
    const index = Math.min(this.#attempt, this.#backoffMs.length - 1);
    const delayMs = this.#backoffMs[index] ?? 0;
    this.#attempt += 1;
    this.#emit('reconnecting');
    this.#cancelReconnect = this.#schedule(() => {
      this.#cancelReconnect = null;
      if (this.#started) this.#open();
    }, delayMs);
  }

  /**
   * The round trip one pong reports, from the instant it echoes back.
   *
   * Stateless by design: the server returns `ClientPing.client_monotonic_ms`
   * untouched (`realtime/server.ts`), so the send instant travels with the
   * exchange and this client keeps no table of pings in flight -- a table that
   * a dropped socket, a resync or a reconnect would each have to clear.
   *
   * **The raw round trip and nothing else.** `ServerPong` carries one server
   * instant, not the receive/send pair `estimateClock` subtracts, so the
   * server's own processing cannot be removed from this figure and no clock
   * offset can be derived from it. The unary `TimeSync` stays the only source
   * of a processing-corrected latency and of the offset; this refines the
   * latency between its rounds and claims nothing more.
   */
  #measureRoundTrip(pong: realtimeV1.ServerPong): void {
    const onLatencySample = this.#options.onLatencySample;
    if (onLatencySample === undefined) return;
    const sentMs = Number(pong.clientMonotonicMs);
    const roundTripMs = this.#now() - sentMs;
    // A pong echoing zero answered no ping this client sent -- the field is a
    // clock reading and never that -- and would be reported as the whole age of
    // the epoch. A negative trip is a clock stepped between the two reads.
    // Neither is a measurement, and one of them would set the median alone.
    if (sentMs <= 0 || roundTripMs < 0) return;
    onLatencySample(roundTripMs);
  }

  #startPing(socket: RealtimeSocketLike): void {
    this.#stopPing();
    const tick = () => {
      if (this.#socket !== socket) return;
      const frame = create(realtimeV1.RealtimeClientFrameSchema, {
        payload: {
          case: 'ping',
          value: { clientMonotonicMs: BigInt(Math.max(0, Math.floor(this.#now()))) },
        },
      });
      this.#send(socket, realtimeV1.RealtimeClientFrameSchema, frame);
      this.#cancelPing = this.#schedule(tick, this.#pingIntervalMs);
    };
    this.#cancelPing = this.#schedule(tick, this.#pingIntervalMs);
  }

  #stopPing(): void {
    this.#cancelPing?.();
    this.#cancelPing = null;
  }

  #send(
    socket: RealtimeSocketLike,
    schema: typeof realtimeV1.RealtimeClientFrameSchema,
    frame: realtimeV1.RealtimeClientFrame,
  ): void {
    const bytes = toBinary(schema, frame);
    if (bytes.byteLength > maxFrameBytes) {
      // The server's `maxPayload` would drop this without a word. Refusing it
      // here at least leaves the socket usable for the next frame.
      return;
    }
    try {
      socket.send(bytes.buffer as ArrayBuffer);
    } catch {
      // A socket that closed between the readiness check and the write. The
      // `close` handler is what reconnects; there is nothing to do here.
    }
  }

  #detach(socket: RealtimeSocketLike | null): void {
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  #emit(status: RealtimeLinkState['status']): void {
    this.#status = status;
    this.#options.onStatus({
      status,
      connectionId: this.#connectionId,
      lastSequence: Number(this.#cursor.appliedSequence()),
      resyncCount: this.#resyncCount,
    });
  }
}

/**
 * The socket address for a control plane's HTTP base.
 *
 * `http` becomes `ws` and `https` becomes `wss`; anything else is left alone
 * so a caller that already handed in a socket scheme is not rewritten. The
 * path is replaced rather than appended, because a base URL with a trailing
 * segment would otherwise produce `/api/realtime`, which the server does not
 * serve. No query string is ever added -- see the class comment.
 *
 * A relative base is resolved against the document, because the web deployment
 * names its own control plane `/api`: the interface and the RPC share an
 * origin there, and no absolute address can be baked into the build when every
 * preview deployment answers on a host of its own. Without the second argument
 * `new URL` throws on such a base, which would turn a configuration that RPC
 * handles perfectly well into a crash on the first socket attempt.
 */
export function realtimeUrl(baseUrl: string): string {
  const url = new URL(baseUrl, documentOrigin());
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  url.pathname = realtimePath;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * The page's own address, when there is a page. `undefined` outside a browser
 * keeps `new URL` at its previous behaviour, so an absolute base resolves the
 * same way it always did and a relative one still throws where nothing could
 * resolve it.
 */
function documentOrigin(): string | undefined {
  return typeof globalThis.location === 'undefined' ? undefined : globalThis.location.href;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  // A text frame. The server never sends one, so this is another script's
  // message or a proxy's, and it is not decoded as Protobuf.
  return null;
}

/**
 * The cursor a socket keeps when it is the group's only transport.
 *
 * Held here rather than as a field so the client has exactly one way to read
 * its position, whether the position is its own or somebody else's.
 */
function createPrivateCursor(): GroupEventCursor {
  let applied = 0n;
  return {
    accept: (sequence) => {
      if (sequence <= applied) return false;
      applied = sequence;
      return true;
    },
    appliedSequence: () => applied,
    rewindTo: (sequence) => {
      applied = sequence < 0n ? 0n : sequence;
    },
  };
}

function maxSequence(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
