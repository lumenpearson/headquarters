import { syncV1 } from '@gremuchaya/protocol';

import type {
  DeviceRole,
  GroupDevice,
  GroupSummary,
  PresenceEntry,
  PresenceStatus,
} from '@/application/sync/connection';
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

/*
 * Wire shapes, declared structurally rather than imported from the generated
 * bindings, in the idiom `BridgeMaterialClient` set: the generated messages are
 * assignable to these, and so is a hand-written fake in a test. Only the fields
 * a conversion reads are named. They live here and not in `ControlPlaneClient`
 * because both paths convert the same four messages -- a call answers a group,
 * a device and a presence, and the log carries the very same three -- and two
 * declarations of one shape are two places for it to drift.
 */

/** The wire timestamp, spelled out because `@bufbuild/protobuf` is not a dependency here. */
export interface WireTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

export interface WireResourceId {
  readonly value: string;
}

/** Only `number` is read; `etag` names the same revision in another alphabet. */
export interface WireRevision {
  readonly number: bigint;
}

export interface WireGroup {
  readonly id?: WireResourceId | undefined;
  readonly name: string;
  readonly authorityMode: number;
  readonly leaderDeviceId?: WireResourceId | undefined;
  readonly revision?: WireRevision | undefined;
}

export interface WireDevice {
  readonly id?: WireResourceId | undefined;
  readonly name: string;
  readonly role: number;
  readonly status: number;
}

export interface WirePresence {
  readonly deviceId?: WireResourceId | undefined;
  readonly status: number;
  readonly activeScreen: string;
  readonly clockOffsetMs: bigint;
  readonly latencyMs: number;
  readonly observedAt?: WireTimestamp | undefined;
}

/**
 * One log event, with every payload the six kinds carry.
 *
 * `group`, `device` and `presence` are converted here rather than left on the
 * wire because a subscriber to the channel is application code and must not see
 * a generated message. They are the whole of what `GROUP_UPDATED`,
 * `DEVICE_UPDATED` and `PRESENCE_UPDATED` mean: the kinds carry no delta, only
 * the new state of the thing they name, which is why a subscriber can apply one
 * without having seen the events before it.
 */
export function toGroupEventEnvelope(event: syncV1.GroupEvent): GroupEventEnvelope {
  const command = event.sessionCommand;
  const group = event.group;
  const device = event.device;
  const presence = event.presence;
  return {
    sequence: event.sequence,
    kind: toGroupEventKind(event.kind),
    actorDeviceId: event.actorDeviceId?.value ?? '',
    documentId: event.documentId?.value ?? '',
    documentDelta: event.documentDelta,
    ...(command === undefined ? {} : { sessionCommand: toGroupSessionCommand(command) }),
    ...(group === undefined ? {} : { group: toGroupSummary(group) }),
    ...(device === undefined ? {} : { device: toGroupDevice(device) }),
    ...(presence === undefined ? {} : { presence: toPresenceEntry(presence) }),
    hybridLogicalClock: event.hybridLogicalClock,
    occurredAt: toIsoInstant(event.occurredAt),
  };
}

export function toDeviceRole(role: number): DeviceRole {
  if (role === syncV1.DeviceRole.ADMIN) return 'ADMIN';
  if (role === syncV1.DeviceRole.EDITOR) return 'EDITOR';
  return 'VIEWER';
}

/**
 * The role as the wire spells it.
 *
 * The inverse of {@link toDeviceRole}, and here rather than in the client
 * because both directions of one mapping belong together: `CreatePairingCode`
 * and `SetDeviceRole` are the two calls that state a role, and a second table
 * beside this one would be a second place for `EDITOR` to mean something else.
 */
export function fromDeviceRole(role: DeviceRole): syncV1.DeviceRole {
  switch (role) {
    case 'ADMIN':
      return syncV1.DeviceRole.ADMIN;
    case 'EDITOR':
      return syncV1.DeviceRole.EDITOR;
    case 'VIEWER':
      return syncV1.DeviceRole.VIEWER;
  }
}

export function toPresenceStatus(status: number): PresenceStatus {
  if (status === syncV1.DeviceStatus.ONLINE) return 'ONLINE';
  if (status === syncV1.DeviceStatus.REVOKED) return 'REVOKED';
  return 'OFFLINE';
}

/**
 * The group as this application holds it, revision included.
 *
 * The revision is the one field a caller cannot recompute and the one the log
 * path depends on: it is how a snapshot replayed out of the retained window is
 * told from one that is news. Zero when the message carried none.
 */
export function toGroupSummary(group: WireGroup): GroupSummary {
  return {
    groupId: group.id?.value ?? '',
    name: group.name,
    authority:
      group.authorityMode === syncV1.AuthorityMode.MULTI_AUTHORITY ? 'multi-authority' : 'leader',
    leaderDeviceId: group.leaderDeviceId?.value ?? '',
    revision: Number(group.revision?.number ?? 0n),
  };
}

export function toGroupDevice(device: WireDevice): GroupDevice {
  return {
    deviceId: device.id?.value ?? '',
    name: device.name,
    role: toDeviceRole(device.role),
    status: toPresenceStatus(device.status),
  };
}

export function toPresenceEntry(presence: WirePresence): PresenceEntry {
  const observed = toEpochMs(presence.observedAt);
  return {
    deviceId: presence.deviceId?.value ?? '',
    status: toPresenceStatus(presence.status),
    activeScreen: presence.activeScreen,
    clockOffsetMs: Number(presence.clockOffsetMs),
    latencyMs: presence.latencyMs,
    observedAt: observed === 0 ? '' : new Date(observed).toISOString(),
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
