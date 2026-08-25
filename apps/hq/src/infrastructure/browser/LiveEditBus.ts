import { screenBusProtocolVersion } from '@gremuchaya/domain';
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import type { SettingsPatch } from '@gremuchaya/settings-schema';

/**
 * Carrying an edit-mode change to the rest of the synchronization group.
 *
 * Every patch the edit panel makes has so far stopped at the session that made
 * it. `advanced.liveEdit` is the opt-in that lets it travel, and that opt-in is
 * scoped `group`: it records what the whole group agreed to, not what this
 * machine prefers. So a session whose group has not enabled it does not merely
 * stay quiet -- it never opens the channel at all, and therefore neither
 * publishes its own edits nor accepts anyone else's. The symmetry is the point.
 * One operator flipping their own copy of the switch must not be able to reach
 * into a session that never agreed, which is also why the enabling patch is
 * not itself published: a group is joined one deliberate opt-in at a time.
 *
 * The transport is the browser one this application already synchronizes
 * screens over -- `BroadcastChannel` with the `storage` fallback of ADR 0001,
 * the envelope and protocol number of `BrowserScreenBus`. It rides its own
 * channel because `ScreenBusPayload` in `@gremuchaya/domain` describes cue and
 * screen traffic and has no settings variant; extending that union belongs to
 * the package that owns it. R27 asks for exactly this delivery, and F10
 * replaces the transport underneath it with the authenticated one. F10 does
 * not replace the gate: which sessions may be reached stays a settings
 * decision on either transport.
 */

/** All a session needs of a transport to take part in live edit. */
export interface LiveEditTransport {
  publish(patches: readonly SettingsPatch[]): void;
  subscribe(listener: (patches: readonly SettingsPatch[]) => void): () => void;
  close(): void;
}

const channelName = 'gremuchaya-hq-live-edit-v1';
const storageKey = '__gremuchaya_live_edit_v1__';

interface LiveEditMessage {
  readonly protocol: typeof screenBusProtocolVersion;
  readonly id: string;
  readonly issuedAt: number;
  readonly senderId: string;
  readonly patches: readonly SettingsPatch[];
}

export function createBrowserLiveEditTransport(): LiveEditTransport {
  const senderId = crypto.randomUUID();
  const listeners = new Set<(patches: readonly SettingsPatch[]) => void>();
  const channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName);

  const dispatch = (value: unknown): void => {
    if (!isLiveEditMessage(value) || value.senderId === senderId) return;
    // The wire is a trust boundary like every other one here: `applyDraftPatch`
    // throws on an unknown identifier or a value its definition rejects, so a
    // session running an older or newer catalogue would otherwise take this one
    // down rather than simply disagree with it. Unusable entries are dropped
    // and the rest of the patch still lands.
    const patches = value.patches.filter(isApplicablePatch);
    if (patches.length === 0) return;
    for (const listener of listeners) listener(patches);
  };

  const handleChannelMessage = (event: MessageEvent<unknown>): void => {
    dispatch(event.data);
  };

  const handleStorageMessage = (event: StorageEvent): void => {
    if (event.key !== storageKey || event.newValue === null) return;
    try {
      dispatch(JSON.parse(event.newValue));
    } catch {
      // Malformed messages from unrelated scripts are ignored.
    }
  };

  channel?.addEventListener('message', handleChannelMessage);
  window.addEventListener('storage', handleStorageMessage);

  return {
    publish(patches) {
      const message: LiveEditMessage = {
        protocol: screenBusProtocolVersion,
        id: crypto.randomUUID(),
        issuedAt: Date.now(),
        senderId,
        patches,
      };
      channel?.postMessage(message);
      try {
        localStorage.setItem(storageKey, JSON.stringify(message));
        localStorage.removeItem(storageKey);
      } catch {
        // BroadcastChannel remains the primary transport when storage is unavailable.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      channel?.removeEventListener('message', handleChannelMessage);
      channel?.close();
      window.removeEventListener('storage', handleStorageMessage);
      listeners.clear();
    },
  };
}

/*
 * One connection for the whole client, in the idiom `KeybindRuntime` already
 * uses: the application runs as a single runtime, and threading a context from
 * the edit runtime down into the store would be ceremony around one instance.
 *
 * `null` is the default and the closed state, and it is what makes the opt-in
 * genuinely off rather than merely unread: with nothing connected there is no
 * channel, so `publishLiveEdit` has nowhere to write.
 */
let connected: LiveEditTransport | null = null;
let applyingRemote = false;

/**
 * Joins the group's live-edit channel until the returned function is called.
 *
 * `apply` is passed in rather than reached for so this module never imports the
 * store that imports it. Its call is bracketed by `applyingRemote` for the
 * reason `initializeOperationsClient` brackets its own remote apply: the store
 * action that lands a patch is the same one that publishes it, and a received
 * patch re-published is two sessions echoing each other forever.
 */
export function connectLiveEdit(
  transport: LiveEditTransport,
  apply: (patches: readonly SettingsPatch[]) => void,
): () => void {
  connected = transport;
  const unsubscribe = transport.subscribe((patches) => {
    applyingRemote = true;
    try {
      apply(patches);
    } finally {
      applyingRemote = false;
    }
  });
  return () => {
    unsubscribe();
    // Only the connection this call opened is dropped: a re-connect that
    // already replaced it must not be closed by the previous effect's cleanup.
    if (connected === transport) connected = null;
  };
}

/** Sends a patch to the group, or does nothing at all when it has not opted in. */
export function publishLiveEdit(patches: readonly SettingsPatch[]): void {
  if (connected === null || applyingRemote || patches.length === 0) return;
  connected.publish(patches);
}

function isApplicablePatch(patch: SettingsPatch): boolean {
  const definition = getSettingDefinition(patch.id);
  return definition !== undefined && definition.validate(patch.value);
}

function isLiveEditMessage(value: unknown): value is LiveEditMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    protocol?: unknown;
    id?: unknown;
    senderId?: unknown;
    patches?: unknown;
  };
  return (
    candidate.protocol === screenBusProtocolVersion &&
    typeof candidate.id === 'string' &&
    typeof candidate.senderId === 'string' &&
    Array.isArray(candidate.patches) &&
    candidate.patches.every(isPatchShape)
  );
}

function isPatchShape(value: unknown): value is SettingsPatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
