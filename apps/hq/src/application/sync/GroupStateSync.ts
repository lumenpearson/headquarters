import {
  groupDevicePatch,
  sortPresence,
  type ConnectionState,
  type GroupDevice,
  type PresenceEntry,
} from './connection';
import type { GroupChannel, GroupEventEnvelope } from './groupChannel';

/**
 * What the group's own state is kept current from: the log (R27 tail).
 *
 * The codec reads six event kinds off the wire and two of them had a
 * subscriber: `document-delta` reaches `GroupLiveEditTransport` and
 * `session-command` reaches `GroupPlaybackSyncTransport`. The three that say
 * what the *group* is -- `group-updated`, `device-updated`, `presence-updated`
 * -- reached nothing, so a leader moved on another machine, a role an
 * administrator changed and a neighbour that left were learned only by the call
 * that happened to ask next: `JoinGroup`, `SetLeader`, `SetAuthorityMode`,
 * `ListDevices` after a revocation, and the fifteen-second presence timer. A
 * session that never made one of those calls kept showing the group as it stood
 * when it joined.
 *
 * This is the subscriber for those three. It writes the same fields
 * `ControlPlaneSession` writes from the answers to calls, which is what makes
 * the version check below necessary rather than decorative.
 *
 * **Where it sits.** Behind `ControlPlaneGroupChannel.deliver`, on
 * `channel.subscribe`, and nowhere near a transport. A device may follow one
 * group over a socket and a poll at the same time, and both feeds carry the
 * same durable log; the channel's cursor is what makes an event that arrived
 * twice reach the subscribers once. A subscriber wired to a transport would be
 * on the wrong side of that and would see the second copy.
 */

/** The fields a decision here is taken against; the store holds them all. */
export interface GroupStateView {
  readonly groupRevision: number;
  readonly session: ConnectionState['session'];
  readonly devices: readonly GroupDevice[];
  readonly presence: readonly PresenceEntry[];
}

export interface GroupStateSyncOptions {
  readonly channel: GroupChannel;
  /** The current view, read per event rather than held, so no copy can go stale. */
  readonly read: () => GroupStateView;
  /** Where a change is recorded. The store's `patchConnection`, in the app. */
  readonly apply: (patch: Partial<ConnectionState>) => void;
}

/**
 * One event, turned into the patch it implies, or `null` for no change.
 *
 * A pure function and not a method, in the idiom `groupEventFeed` set for the
 * poll cadence: what the group becomes on an event is a rule worth reading on
 * its own, and every case below is a decision rather than a copy.
 *
 * **The echo is not filtered by actor, and that is the difference from live
 * edit.** `GroupLiveEditTransport` drops an event whose `actorDeviceId` is this
 * device, because a settings delta carries no version and re-applying one would
 * land the patch twice and write a second history entry for one change. These
 * three kinds carry a snapshot with a version instead, so the version answers
 * the same question more precisely: a snapshot at a revision this session has
 * already recorded changes nothing whoever caused it, and a snapshot at a newer
 * revision is news even when this device caused it -- which is exactly the case
 * of a `SetLeader` whose answer never arrived because the socket dropped
 * between the append and the response.
 *
 * **The version is what orders the two paths.** `groups.revision` is bumped by
 * the server inside the same statement as every mutation that changes a name, an
 * authority mode, a leader or a role (`group-mutations.ts`,
 * `groupMutationEpilogue`), so it is unique per mutation and monotonic. Arrival
 * order cannot stand in for it: a feed resuming from a cursor of zero replays
 * the whole retained window, and every snapshot in that window is valid and
 * older than what `JoinGroup` just established. Strictly newer, therefore, and
 * not newer-or-equal: equal means the same mutation, which this session already
 * holds.
 */
export function groupStatePatch(
  view: GroupStateView,
  event: GroupEventEnvelope,
): Partial<ConnectionState> | null {
  switch (event.kind) {
    case 'group-updated':
      return groupPatch(view, event);
    case 'device-updated': {
      const group = groupPatch(view, event);
      const device = event.device;
      if (group === null || device === undefined || device.deviceId === '') return group;
      // The same rule the answer to `SetDeviceRole` is applied by, in one
      // place: the two paths carry the same message and must write one roster.
      return { ...group, ...groupDevicePatch(view, device) };
    }
    case 'presence-updated':
      return presencePatch(view, event);
    default:
      // `document-delta` and `session-command` have their own subscribers, and
      // `snapshot-required` is decoded but never published: nothing in
      // `apps/control-plane` appends it, and a client learns the same fact from
      // the `ResyncRequired` frame or the `resync_required` field of a page.
      return null;
  }
}

/**
 * Subscribes the group's state to the log, and answers with the unsubscribe.
 *
 * The subscription is taken before any feed starts, so a page that arrives on
 * the first tick is not delivered into an empty listener set.
 */
export function connectGroupState(options: GroupStateSyncOptions): () => void {
  return options.channel.subscribe((event) => {
    const patch = groupStatePatch(options.read(), event);
    if (patch !== null) options.apply(patch);
  });
}

/** The group snapshot both `group-updated` and `device-updated` carry. */
function groupPatch(
  view: GroupStateView,
  event: GroupEventEnvelope,
): Partial<ConnectionState> | null {
  const group = event.group;
  if (group === undefined) return null;
  if (group.revision <= view.groupRevision) return null;
  return {
    groupRevision: group.revision,
    groupName: group.name,
    authority: group.authority,
    leaderDeviceId: group.leaderDeviceId,
  };
}

/**
 * One device's presence, folded into the list the timer owns.
 *
 * **Ownership, stated once.** `GetPresence` on its fifteen-second timer stays
 * the owner of the list and of this device's own liveness: the call renews the
 * caller's key server-side, which is the only thing that keeps a sitting
 * session from reporting itself `OFFLINE` three quarters of a minute after
 * joining. This path renews nothing, asks nothing and touches no timer -- it
 * only writes down the one device an event named, so that a neighbour joining
 * or leaving is visible on the next event rather than on the next tick. Calling
 * `GetPresence` from here would double a metered call and duplicate a renewal
 * that already cannot be forgotten.
 *
 * A presence carries no revision, so `observedAt` orders it: the server stamps
 * it at the moment it recorded the change, and a stamp older than the one this
 * session already holds for that device comes from a replayed window rather
 * than from news. Equal stamps are applied, because that is the same
 * observation and re-writing it changes nothing. An event with no stamp at all
 * reads as epoch zero and so loses to any dated entry -- the honest answer for
 * a record that cannot be placed in time.
 */
function presencePatch(
  view: GroupStateView,
  event: GroupEventEnvelope,
): Partial<ConnectionState> | null {
  const entry = event.presence;
  if (entry === undefined || entry.deviceId === '') return null;
  const held = view.presence.find((candidate) => candidate.deviceId === entry.deviceId);
  if (held !== undefined && observedMs(entry) < observedMs(held)) return null;
  if (held !== undefined && samePresence(held, entry)) return null;
  const merged =
    held === undefined
      ? [...view.presence, entry]
      : view.presence.map((candidate) =>
          candidate.deviceId === entry.deviceId ? entry : candidate,
        );
  return { presence: sortPresence(merged) };
}

function observedMs(entry: PresenceEntry): number {
  const parsed = Date.parse(entry.observedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function samePresence(left: PresenceEntry, right: PresenceEntry): boolean {
  return (
    left.status === right.status &&
    left.activeScreen === right.activeScreen &&
    left.clockOffsetMs === right.clockOffsetMs &&
    left.latencyMs === right.latencyMs &&
    left.observedAt === right.observedAt
  );
}
