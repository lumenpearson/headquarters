/**
 * The group's event channel, as the application reasons about it (R27).
 *
 * `ControlPlanePort` describes the request/response half of the control plane:
 * pair, refresh, join, list. This describes the other half -- what arrives
 * unasked and what is published into it -- and is deliberately a separate
 * contract, because the two are served by different transports. Requests go
 * over binary gRPC-Web; events arrive over the realtime socket. A surface that
 * needs both takes both.
 *
 * Everything here is a plain type. The generated Protobuf messages stay in
 * infrastructure, where `RealtimeClient` converts them, in the direction
 * `dependency-map.md` fixes.
 */

/** What a hello frame has to carry. Read at the moment a socket opens. */
export interface RealtimeIdentity {
  readonly groupId: string;
  readonly deviceId: string;
  /**
   * The bearer the server matches against the group/device pair. It travels in
   * the frame body and never in the URL: see `RealtimeClient`.
   */
  readonly accessToken: string;
  /** Empty for this client; see `RealtimeClient.#sendHello`. */
  readonly documentStateVector?: Uint8Array;
}

/** The six event kinds of `GroupEventKind`, in this application's register. */
export type GroupEventKind =
  | 'unspecified'
  | 'group-updated'
  | 'device-updated'
  | 'presence-updated'
  | 'document-delta'
  | 'session-command'
  | 'snapshot-required';

/** The five document types `SynchronizedDocumentType` names. */
export type SynchronizedDocumentType =
  'unspecified' | 'layout' | 'settings' | 'content' | 'keymap' | 'simulation';

/** The eight session-command actions, in this application's register. */
export type GroupSessionAction =
  'unspecified' | 'navigate' | 'select' | 'play' | 'pause' | 'seek' | 'set-rate' | 'set-scene';

/**
 * One session command as the server allocated it.
 *
 * `epoch` and `sequence` are server facts -- the epoch is the group revision
 * the command was issued against, the sequence the one the append allocated --
 * and a client that chose either would let two sessions disagree about which
 * command is newer (`sync/service.ts`, `publishSessionCommand`).
 */
export interface GroupSessionCommand {
  readonly epoch: bigint;
  readonly sequence: bigint;
  readonly action: GroupSessionAction;
  readonly target: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  /** Epoch milliseconds, or 0 when the server sent no instant. */
  readonly executeAtMs: number;
  readonly issuedByDeviceId: string;
}

export interface GroupEventEnvelope {
  readonly sequence: bigint;
  readonly kind: GroupEventKind;
  /**
   * Who caused the event, which for a role change is the administrator rather
   * than the device the change is about. It is what lets a subscriber
   * recognise the echo of its own publication.
   */
  readonly actorDeviceId: string;
  /** Empty unless `kind` is `document-delta`. */
  readonly documentId: string;
  readonly documentDelta: Uint8Array;
  readonly sessionCommand?: GroupSessionCommand | undefined;
  readonly hybridLogicalClock: bigint;
  /** ISO 8601, or empty when the server sent no instant. */
  readonly occurredAt: string;
}

export interface DocumentDeltaPublication {
  readonly documentId: string;
  readonly documentType: SynchronizedDocumentType;
  readonly delta: Uint8Array;
  readonly stateVector?: Uint8Array;
  readonly hybridLogicalClock?: bigint;
}

export interface DocumentDeltaReceipt {
  readonly sequence: bigint;
  readonly stateVector: Uint8Array;
}

/** What a caller asks for. The server fills in `epoch`, `sequence` and issuer. */
export interface SessionCommandPublication {
  readonly action: GroupSessionAction;
  readonly target: string;
  readonly positionSeconds?: number;
  readonly playbackRate?: number;
  /** Epoch milliseconds. Omitted means "as soon as it arrives". */
  readonly executeAtMs?: number;
}

export interface DocumentSnapshot {
  readonly snapshot: Uint8Array;
  readonly stateVector: Uint8Array;
  /** The event sequence the snapshot was taken at; a resume starts here. */
  readonly sequence: bigint;
  readonly documentType: SynchronizedDocumentType;
}

/**
 * What a live-edit transport or a playback coordinator needs of the group.
 *
 * Deliberately narrow: publish two kinds of thing, and hear everything. The
 * session's identity is on it because both publishers filter their own echo
 * by device, and reaching into the store for it from a transport would be the
 * presentation layer's job done in the wrong place.
 */
export interface GroupChannel {
  readonly groupId: string;
  readonly deviceId: string;
  publishDocumentDelta(publication: DocumentDeltaPublication): Promise<DocumentDeltaReceipt>;
  publishSessionCommand(publication: SessionCommandPublication): Promise<GroupSessionCommand>;
  subscribe(listener: (event: GroupEventEnvelope) => void): () => void;
}
