const protocolVersion = 1 as const;
const defaultGroupId = 'local-browser';
const defaultExecutionDelayMs = 40;
const maximumExecutionDelayMs = 5_000;
const storagePrefix = '__gremuchaya_playback_sync_v1__:';

export type PlaybackSyncAction = 'PLAY' | 'PAUSE' | 'SEEK' | 'SET_RATE' | 'SELECT';
export type PlaybackSyncAuthority = 'LEADER' | 'MULTI_AUTHORITY';
export type PlaybackSyncSourceKind = 'DEMO_VIDEO' | 'LOCAL_MATERIAL';

export interface PlaybackSyncTarget {
  readonly cameraId: string;
  readonly sourceKind: PlaybackSyncSourceKind;
  readonly materialId?: string;
}

export interface PlaybackSyncCommand {
  readonly epoch: number;
  readonly sequence: number;
  readonly action: PlaybackSyncAction;
  readonly target: PlaybackSyncTarget;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly executeAtMs: number;
  readonly issuedAtMs: number;
  readonly issuedByDeviceId: string;
}

export interface PlaybackSyncCommandInput {
  readonly action: PlaybackSyncAction;
  readonly target: PlaybackSyncTarget;
  readonly positionSeconds?: number;
  readonly playbackRate?: number;
}

export interface PlaybackSyncTransport {
  publish(command: PlaybackSyncCommand): void;
  subscribe(listener: (command: PlaybackSyncCommand) => void): () => void;
  close(): void;
}

export interface PlaybackSyncCoordinatorOptions {
  readonly onCommand: (command: PlaybackSyncCommand) => void;
  readonly groupId?: string;
  readonly deviceId?: string;
  readonly authority?: PlaybackSyncAuthority;
  readonly leaderDeviceId?: string;
  readonly executionDelayMs?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly transport?: PlaybackSyncTransport;
}

/**
 * Orders media actions before their scheduled execution time. The default
 * transport synchronizes same-profile browser windows. The command shape is
 * intentionally compatible with the future generated SyncService command: it
 * contains no local path, Blob URL, loopback grant or MediaStream reference.
 */
export class PlaybackSyncCoordinator {
  readonly #deviceId: string;
  readonly #authority: PlaybackSyncAuthority;
  readonly #leaderDeviceId: string | undefined;
  readonly #executionDelayMs: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #transport: PlaybackSyncTransport;
  readonly #unsubscribe: () => void;
  readonly #lastSequenceByDevice = new Map<string, number>();
  readonly #latestByTarget = new Map<string, PlaybackSyncCommand>();
  readonly #cancelByTarget = new Map<string, () => void>();
  #sequence = 0;
  #closed = false;

  constructor(private readonly options: PlaybackSyncCoordinatorOptions) {
    this.#deviceId = options.deviceId ?? createDeviceId();
    this.#authority = options.authority ?? 'MULTI_AUTHORITY';
    this.#leaderDeviceId = options.leaderDeviceId;
    this.#executionDelayMs = validatedExecutionDelay(options.executionDelayMs);
    this.#now = options.now ?? Date.now;
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timeoutId = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timeoutId);
      });
    this.#transport = options.transport ?? new BrowserPlaybackSyncTransport(options.groupId);
    this.#unsubscribe = this.#transport.subscribe((command) => this.#receive(command));
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  publish(input: PlaybackSyncCommandInput): PlaybackSyncCommand | null {
    if (this.#closed || !isPlaybackSyncTarget(input.target)) return null;
    if (this.#authority === 'LEADER' && this.#leaderDeviceId !== this.#deviceId) return null;

    const issuedAtMs = this.#now();
    const command: PlaybackSyncCommand = {
      epoch: 1,
      sequence: this.#sequence + 1,
      action: input.action,
      target: input.target,
      positionSeconds: nonNegativeFinite(input.positionSeconds ?? 0),
      playbackRate: positiveFinite(input.playbackRate ?? 1),
      issuedAtMs,
      executeAtMs: issuedAtMs + this.#executionDelayMs,
      issuedByDeviceId: this.#deviceId,
    };
    this.#sequence = command.sequence;
    this.#lastSequenceByDevice.set(this.#deviceId, command.sequence);
    if (this.#accept(command)) {
      this.#transport.publish(command);
      this.#scheduleCommand(command);
      return command;
    }
    return null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const cancel of this.#cancelByTarget.values()) cancel();
    this.#cancelByTarget.clear();
    this.#transport.close();
  }

  #receive(command: PlaybackSyncCommand): void {
    if (this.#closed || command.issuedByDeviceId === this.#deviceId) return;
    if (!isPlaybackSyncCommand(command)) return;
    if (this.#authority === 'LEADER' && command.issuedByDeviceId !== this.#leaderDeviceId) return;
    const lastSequence = this.#lastSequenceByDevice.get(command.issuedByDeviceId) ?? 0;
    if (command.sequence <= lastSequence) return;
    this.#lastSequenceByDevice.set(command.issuedByDeviceId, command.sequence);
    if (this.#accept(command)) this.#scheduleCommand(command);
  }

  #accept(command: PlaybackSyncCommand): boolean {
    const key = targetKey(command.target);
    const previous = this.#latestByTarget.get(key);
    if (previous !== undefined && compareCommands(command, previous) <= 0) return false;
    this.#latestByTarget.set(key, command);
    this.#cancelByTarget.get(key)?.();
    this.#cancelByTarget.delete(key);
    return true;
  }

  #scheduleCommand(command: PlaybackSyncCommand): void {
    const key = targetKey(command.target);
    const delayMs = Math.max(0, command.executeAtMs - this.#now());
    const cancel = this.#schedule(() => {
      this.#cancelByTarget.delete(key);
      if (this.#closed || this.#latestByTarget.get(key) !== command) return;
      this.options.onCommand(command);
    }, delayMs);
    this.#cancelByTarget.set(key, cancel);
  }
}

/** Browser-local transport. It synchronizes windows of the same browser profile
 * and origin; cloud/group transport is deliberately attached later through the
 * same PlaybackSyncTransport interface. */
export class BrowserPlaybackSyncTransport implements PlaybackSyncTransport {
  readonly #channel: BroadcastChannel | null;
  readonly #listeners = new Set<(command: PlaybackSyncCommand) => void>();
  readonly #storageKey: string;

  constructor(groupId = defaultGroupId) {
    const normalizedGroupId = normalizeGroupId(groupId);
    this.#storageKey = `${storagePrefix}${normalizedGroupId}`;
    this.#channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel(`gremuchaya-hq:playback-sync:v1:${normalizedGroupId}`);
    this.#channel?.addEventListener('message', this.#onChannelMessage);
    window.addEventListener('storage', this.#onStorageMessage);
  }

  publish(command: PlaybackSyncCommand): void {
    const frame = { protocol: protocolVersion, command };
    this.#channel?.postMessage(frame);
    try {
      localStorage.setItem(this.#storageKey, JSON.stringify(frame));
      localStorage.removeItem(this.#storageKey);
    } catch {
      // BroadcastChannel remains available when browser storage is unavailable.
    }
  }

  subscribe(listener: (command: PlaybackSyncCommand) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#channel?.removeEventListener('message', this.#onChannelMessage);
    this.#channel?.close();
    window.removeEventListener('storage', this.#onStorageMessage);
    this.#listeners.clear();
  }

  readonly #onChannelMessage = (event: MessageEvent<unknown>): void => {
    this.#dispatch(event.data);
  };

  readonly #onStorageMessage = (event: StorageEvent): void => {
    if (event.key !== this.#storageKey || event.newValue === null) return;
    try {
      this.#dispatch(JSON.parse(event.newValue));
    } catch {
      // A malformed storage event cannot control playback.
    }
  };

  #dispatch(value: unknown): void {
    if (!isPlaybackSyncFrame(value)) return;
    for (const listener of this.#listeners) listener(value.command);
  }
}

export function createPlaybackSyncTarget(
  cameraId: string,
  sourceKind: PlaybackSyncSourceKind,
  materialId?: string,
): PlaybackSyncTarget | null {
  const target = { cameraId, sourceKind, ...(materialId === undefined ? {} : { materialId }) };
  return isPlaybackSyncTarget(target) ? target : null;
}

function isPlaybackSyncFrame(value: unknown): value is {
  readonly protocol: typeof protocolVersion;
  readonly command: PlaybackSyncCommand;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { protocol?: unknown; command?: unknown };
  return candidate.protocol === protocolVersion && isPlaybackSyncCommand(candidate.command);
}

function isPlaybackSyncCommand(value: unknown): value is PlaybackSyncCommand {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PlaybackSyncCommand>;
  return (
    Number.isSafeInteger(candidate.epoch) &&
    candidate.epoch !== undefined &&
    candidate.epoch > 0 &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence !== undefined &&
    candidate.sequence > 0 &&
    isPlaybackSyncAction(candidate.action) &&
    isPlaybackSyncTarget(candidate.target) &&
    isNonNegativeFinite(candidate.positionSeconds) &&
    isPositiveFinite(candidate.playbackRate) &&
    isPositiveFinite(candidate.executeAtMs) &&
    isPositiveFinite(candidate.issuedAtMs) &&
    typeof candidate.issuedByDeviceId === 'string' &&
    candidate.issuedByDeviceId.length > 0 &&
    candidate.issuedByDeviceId.length <= 128
  );
}

function isPlaybackSyncAction(value: unknown): value is PlaybackSyncAction {
  return (
    value === 'PLAY' ||
    value === 'PAUSE' ||
    value === 'SEEK' ||
    value === 'SET_RATE' ||
    value === 'SELECT'
  );
}

function isPlaybackSyncTarget(value: unknown): value is PlaybackSyncTarget {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PlaybackSyncTarget>;
  if (
    typeof candidate.cameraId !== 'string' ||
    candidate.cameraId.length === 0 ||
    candidate.cameraId.length > 128 ||
    (candidate.sourceKind !== 'DEMO_VIDEO' && candidate.sourceKind !== 'LOCAL_MATERIAL')
  ) {
    return false;
  }
  return candidate.sourceKind === 'DEMO_VIDEO'
    ? candidate.materialId === undefined
    : typeof candidate.materialId === 'string' && isUuid(candidate.materialId);
}

function compareCommands(left: PlaybackSyncCommand, right: PlaybackSyncCommand): number {
  return (
    left.epoch - right.epoch ||
    left.issuedAtMs - right.issuedAtMs ||
    left.sequence - right.sequence ||
    left.issuedByDeviceId.localeCompare(right.issuedByDeviceId, 'en-US')
  );
}

function targetKey(target: PlaybackSyncTarget): string {
  return `${target.cameraId}:${target.sourceKind}:${target.materialId ?? ''}`;
}

function createDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `browser-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function normalizeGroupId(value: string | undefined): string {
  if (value === undefined) return defaultGroupId;
  return /^[a-z0-9_-]{1,128}$/iu.test(value) ? value : defaultGroupId;
}

function validatedExecutionDelay(value: number | undefined): number {
  if (value === undefined) return defaultExecutionDelayMs;
  return Number.isSafeInteger(value) && value >= 0 && value <= maximumExecutionDelayMs
    ? value
    : defaultExecutionDelayMs;
}

function nonNegativeFinite(value: number): number {
  return isNonNegativeFinite(value) ? value : 0;
}

function positiveFinite(value: number): number {
  return isPositiveFinite(value) ? value : 1;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
