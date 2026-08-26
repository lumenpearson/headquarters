import { syncV1 } from '@gremuchaya/protocol';

import type {
  GroupEventEnvelope,
  GroupEventKind,
  GroupSessionAction,
  GroupSessionCommand,
  SynchronizedDocumentType,
} from '@/application/sync/groupChannel';

/*
 * The wire-to-application conversion for everything the group log carries.
 *
 * It lives in infrastructure and not beside the types it produces because the
 * generated `syncV1` enums are the transport, and the application layer owns
 * no transport. `RealtimeClient` decodes frames into these; `ControlPlaneClient`
 * produces the same shapes from its RPC responses, so a caller cannot tell
 * which path an event arrived by -- which is the point, since the same event
 * arrives by both after a resume.
 */

/** The wire timestamp, spelled out as `ControlPlaneClient` spells it. */
interface WireTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

export function toGroupEventEnvelope(event: syncV1.GroupEvent): GroupEventEnvelope {
  const command = event.sessionCommand;
  return {
    sequence: event.sequence,
    kind: toGroupEventKind(event.kind),
    actorDeviceId: event.actorDeviceId?.value ?? '',
    documentId: event.documentId?.value ?? '',
    documentDelta: event.documentDelta,
    ...(command === undefined ? {} : { sessionCommand: toGroupSessionCommand(command) }),
    hybridLogicalClock: event.hybridLogicalClock,
    occurredAt: toIsoInstant(event.occurredAt),
  };
}

export function toGroupSessionCommand(command: syncV1.SessionCommand): GroupSessionCommand {
  return {
    epoch: command.epoch,
    sequence: command.sequence,
    action: toGroupSessionAction(command.action),
    target: command.target,
    positionSeconds: command.positionSeconds,
    playbackRate: command.playbackRate,
    executeAtMs: toEpochMs(command.executeAt),
    issuedByDeviceId: command.issuedByDeviceId?.value ?? '',
  };
}

export function toGroupEventKind(kind: syncV1.GroupEventKind): GroupEventKind {
  switch (kind) {
    case syncV1.GroupEventKind.GROUP_UPDATED:
      return 'group-updated';
    case syncV1.GroupEventKind.DEVICE_UPDATED:
      return 'device-updated';
    case syncV1.GroupEventKind.PRESENCE_UPDATED:
      return 'presence-updated';
    case syncV1.GroupEventKind.DOCUMENT_DELTA:
      return 'document-delta';
    case syncV1.GroupEventKind.SESSION_COMMAND:
      return 'session-command';
    case syncV1.GroupEventKind.SNAPSHOT_REQUIRED:
      return 'snapshot-required';
    default:
      return 'unspecified';
  }
}

export function toGroupSessionAction(action: syncV1.SessionCommandAction): GroupSessionAction {
  switch (action) {
    case syncV1.SessionCommandAction.NAVIGATE:
      return 'navigate';
    case syncV1.SessionCommandAction.SELECT:
      return 'select';
    case syncV1.SessionCommandAction.PLAY:
      return 'play';
    case syncV1.SessionCommandAction.PAUSE:
      return 'pause';
    case syncV1.SessionCommandAction.SEEK:
      return 'seek';
    case syncV1.SessionCommandAction.SET_RATE:
      return 'set-rate';
    case syncV1.SessionCommandAction.SET_SCENE:
      return 'set-scene';
    default:
      return 'unspecified';
  }
}

export function fromGroupSessionAction(action: GroupSessionAction): syncV1.SessionCommandAction {
  switch (action) {
    case 'navigate':
      return syncV1.SessionCommandAction.NAVIGATE;
    case 'select':
      return syncV1.SessionCommandAction.SELECT;
    case 'play':
      return syncV1.SessionCommandAction.PLAY;
    case 'pause':
      return syncV1.SessionCommandAction.PAUSE;
    case 'seek':
      return syncV1.SessionCommandAction.SEEK;
    case 'set-rate':
      return syncV1.SessionCommandAction.SET_RATE;
    case 'set-scene':
      return syncV1.SessionCommandAction.SET_SCENE;
    default:
      return syncV1.SessionCommandAction.UNSPECIFIED;
  }
}

export function toSynchronizedDocumentType(
  documentType: syncV1.SynchronizedDocumentType,
): SynchronizedDocumentType {
  switch (documentType) {
    case syncV1.SynchronizedDocumentType.LAYOUT:
      return 'layout';
    case syncV1.SynchronizedDocumentType.SETTINGS:
      return 'settings';
    case syncV1.SynchronizedDocumentType.CONTENT:
      return 'content';
    case syncV1.SynchronizedDocumentType.KEYMAP:
      return 'keymap';
    case syncV1.SynchronizedDocumentType.SIMULATION:
      return 'simulation';
    default:
      return 'unspecified';
  }
}

export function fromSynchronizedDocumentType(
  documentType: SynchronizedDocumentType,
): syncV1.SynchronizedDocumentType {
  switch (documentType) {
    case 'layout':
      return syncV1.SynchronizedDocumentType.LAYOUT;
    case 'settings':
      return syncV1.SynchronizedDocumentType.SETTINGS;
    case 'content':
      return syncV1.SynchronizedDocumentType.CONTENT;
    case 'keymap':
      return syncV1.SynchronizedDocumentType.KEYMAP;
    case 'simulation':
      return syncV1.SynchronizedDocumentType.SIMULATION;
    default:
      return syncV1.SynchronizedDocumentType.UNSPECIFIED;
  }
}

export function toEpochMs(timestamp: WireTimestamp | undefined): number {
  if (timestamp === undefined) return 0;
  return Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
}

export function toWireTimestamp(epochMs: number): WireTimestamp {
  const seconds = Math.floor(epochMs / 1000);
  return { seconds: BigInt(seconds), nanos: Math.round((epochMs - seconds * 1000) * 1_000_000) };
}

function toIsoInstant(timestamp: WireTimestamp | undefined): string {
  const epochMs = toEpochMs(timestamp);
  return epochMs === 0 ? '' : new Date(epochMs).toISOString();
}
