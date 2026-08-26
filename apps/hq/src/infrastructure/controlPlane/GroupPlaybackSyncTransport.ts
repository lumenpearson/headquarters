import type {
  GroupChannel,
  GroupSessionAction,
  GroupSessionCommand,
} from '@/application/sync/groupChannel';
import type {
  PlaybackSyncAction,
  PlaybackSyncAllocation,
  PlaybackSyncCommand,
  PlaybackSyncSourceKind,
  PlaybackSyncTarget,
  PlaybackSyncTransport,
} from '@/infrastructure/media/PlaybackSyncCoordinator';

/**
 * How a playback target is written into `SessionCommand.target`.
 *
 * `SessionCommand` has one `target` string, and a playback target is three
 * fields. They are joined with `|` because neither a camera id nor a material
 * id may contain one -- both are validated identifiers -- so the split is
 * unambiguous, and a target that does not parse is dropped rather than guessed
 * at. The shape is written here rather than in `PlaybackSyncCoordinator`
 * because it is a fact about this wire and no other.
 */
const targetSeparator = '|';

export interface GroupPlaybackSyncTransportOptions {
  readonly channel: GroupChannel;
  /** Reported when the group refuses a command; see the coordinator's option. */
  readonly onPublishFailed?: (error: unknown) => void;
}

/**
 * Playback synchronization over `PublishSessionCommand` (R21, R27).
 *
 * The browser transport reaches other tabs of one profile. This one reaches
 * every admitted device, and -- more to the point -- it reaches the server
 * that owns the ordering: `publish` answers with the epoch and sequence the
 * append allocated, which the coordinator adopts in place of the pair it
 * assigned locally.
 *
 * A command the group refuses is not silently dropped. Under `LEADER`
 * authority the server answers `FAILED_PRECONDITION` to anyone but the leader,
 * and the publication rate limiter answers `RESOURCE_EXHAUSTED`; both arrive
 * at `onPublishFailed`, so the screen can say `LOCAL ONLY` rather than claim a
 * synchronization that is not happening.
 *
 * `execute_at` is carried in both directions exactly as given: the control
 * plane copies the client's value into the appended event and neither the hub
 * nor the poll feed touches it. That is why the coordinator puts the group's
 * clock on it rather than the issuing machine's -- there is no point on this
 * path where a server could restate the instant, so the clients state it on
 * one scale themselves (R27).
 */
export function createGroupPlaybackSyncTransport(
  options: GroupPlaybackSyncTransportOptions,
): PlaybackSyncTransport {
  const { channel } = options;
  const listeners = new Set<(command: PlaybackSyncCommand) => void>();
  let closed = false;

  const unsubscribe = channel.subscribe((event) => {
    if (closed || event.kind !== 'session-command') return;
    const command = event.sessionCommand;
    if (command === undefined) return;
    // The issuer hears its own append back. The coordinator drops a command
    // from its own device already, but filtering here keeps the echo from
    // ever entering the ordering maps in the first place.
    if (command.issuedByDeviceId === channel.deviceId) return;
    const converted = toPlaybackSyncCommand(command, event.occurredAt);
    if (converted === null) return;
    for (const listener of [...listeners]) listener(converted);
  });

  return {
    publish(command: PlaybackSyncCommand): Promise<PlaybackSyncAllocation | null> {
      if (closed) return Promise.resolve(null);
      return channel
        .publishSessionCommand({
          action: toGroupSessionAction(command.action),
          target: encodeTarget(command.target),
          positionSeconds: command.positionSeconds,
          playbackRate: command.playbackRate,
          executeAtMs: command.executeAtMs,
        })
        .then((published) => toAllocation(published))
        .catch((error: unknown) => {
          options.onPublishFailed?.(error);
          // Answering `null` rather than rethrowing keeps the local schedule:
          // the operator's own screen obeys the operator even when the group
          // refused the command, and the refusal has already been reported.
          return null;
        });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}

/**
 * The server's ordering, or `null` when it does not fit a JavaScript number.
 *
 * `epoch` and `sequence` are `uint64` on the wire. Neither reaches
 * `Number.MAX_SAFE_INTEGER` in this deployment -- one counts group revisions
 * and the other appended events -- but a value that did would silently lose
 * precision, and a silently wrong ordering is worse than keeping the local one.
 */
export function toAllocation(command: GroupSessionCommand): PlaybackSyncAllocation | null {
  const epoch = Number(command.epoch);
  const sequence = Number(command.sequence);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return null;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return { epoch, sequence };
}

export function encodeTarget(target: PlaybackSyncTarget): string {
  return [target.cameraId, target.sourceKind, target.materialId ?? ''].join(targetSeparator);
}

export function decodeTarget(target: string): PlaybackSyncTarget | null {
  const parts = target.split(targetSeparator);
  if (parts.length !== 3) return null;
  const [cameraId, sourceKind, materialId] = parts;
  if (cameraId === undefined || cameraId.length === 0) return null;
  if (sourceKind !== 'DEMO_VIDEO' && sourceKind !== 'LOCAL_MATERIAL') return null;
  const kind: PlaybackSyncSourceKind = sourceKind;
  if (kind === 'DEMO_VIDEO') return { cameraId, sourceKind: kind };
  if (materialId === undefined || materialId.length === 0) return null;
  return { cameraId, sourceKind: kind, materialId };
}

function toPlaybackSyncCommand(
  command: GroupSessionCommand,
  occurredAt: string,
): PlaybackSyncCommand | null {
  const action = toPlaybackSyncAction(command.action);
  if (action === null) return null;
  const target = decodeTarget(command.target);
  if (target === null) return null;
  const allocation = toAllocation(command);
  if (allocation === null) return null;
  const issuedAtMs = Date.parse(occurredAt);
  const executeAtMs = command.executeAtMs;
  return {
    epoch: allocation.epoch,
    sequence: allocation.sequence,
    action,
    target,
    positionSeconds: command.positionSeconds,
    playbackRate: command.playbackRate > 0 ? command.playbackRate : 1,
    // `issued_at` is not on the wire, so the event's own instant stands in for
    // it; it only ever breaks a tie between two commands of equal epoch. Both
    // candidates are already on the group's clock -- `occurred_at` is the
    // server's own stamp and `executeAtMs` was converted before publication --
    // so the tie is broken between comparable numbers rather than between two
    // machines' idea of the time.
    issuedAtMs: Number.isNaN(issuedAtMs) ? executeAtMs : issuedAtMs,
    executeAtMs,
    issuedByDeviceId: command.issuedByDeviceId,
  };
}

function toGroupSessionAction(action: PlaybackSyncAction): GroupSessionAction {
  switch (action) {
    case 'PLAY':
      return 'play';
    case 'PAUSE':
      return 'pause';
    case 'SEEK':
      return 'seek';
    case 'SET_RATE':
      return 'set-rate';
    case 'SELECT':
      return 'select';
  }
}

function toPlaybackSyncAction(action: GroupSessionAction): PlaybackSyncAction | null {
  switch (action) {
    case 'play':
      return 'PLAY';
    case 'pause':
      return 'PAUSE';
    case 'seek':
      return 'SEEK';
    case 'set-rate':
      return 'SET_RATE';
    case 'select':
      return 'SELECT';
    default:
      // `navigate` and `set-scene` are group commands this coordinator does not
      // own; another surface will, and neither is playback.
      return null;
  }
}
