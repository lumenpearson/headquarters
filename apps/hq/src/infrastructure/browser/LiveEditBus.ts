import { screenBusProtocolVersion } from '@gremuchaya/domain';
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import type { SettingsPatch } from '@gremuchaya/settings-schema';

import {
  getContentFieldDefinition,
  seedContentValue,
  type ContentPatch,
} from '@/application/edit/contentFields';

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
 *
 * A patch set carries either kind, never both: a settings patch and a content
 * patch are validated against two different registries
 * (`getSettingDefinition` against a seeded entity's field), and a listener
 * that had to guess which applied to a mixed array would be guessing at a
 * trust boundary. `kind` is what a receiver reads before it reads anything
 * else in `patches`.
 */

/** All a session needs of a transport to take part in live edit. */
export type LiveEditPatchSet =
  | { readonly kind: 'settings'; readonly patches: readonly SettingsPatch[] }
  | { readonly kind: 'content'; readonly patches: readonly ContentPatch[] };

export interface LiveEditTransport {
  publish(patchSet: LiveEditPatchSet): void;
  subscribe(listener: (patchSet: LiveEditPatchSet) => void): () => void;
  close(): void;
}

const channelName = 'gremuchaya-hq-live-edit-v1';
const storageKey = '__gremuchaya_live_edit_v1__';

interface LiveEditMessage {
  readonly protocol: typeof screenBusProtocolVersion;
  readonly id: string;
  readonly issuedAt: number;
  readonly senderId: string;
  /**
   * Absent means `'settings'`: every session before content rode this bus
   * sent no such field, and a message from one of them is not a message with
   * an empty content patch set, it is a settings patch as it always was.
   */
  readonly kind?: 'settings' | 'content';
  readonly patches: readonly SettingsPatch[] | readonly ContentPatch[];
}

export function createBrowserLiveEditTransport(): LiveEditTransport {
  const senderId = crypto.randomUUID();
  const listeners = new Set<(patchSet: LiveEditPatchSet) => void>();
  const channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName);

  const dispatch = (value: unknown): void => {
    if (!isLiveEditMessage(value) || value.senderId === senderId) return;
    // The wire is a trust boundary like every other one here: `applyDraftPatch`
    // throws on an unknown identifier or a value its definition rejects, so a
    // session running an older or newer catalogue would otherwise take this one
    // down rather than simply disagree with it. Unusable entries are dropped
    // and the rest of the patch still lands.
    const patchSet = toPatchSet(value);
    if (patchSet === null) return;
    for (const listener of listeners) listener(patchSet);
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
    publish(patchSet) {
      const message: LiveEditMessage = {
        protocol: screenBusProtocolVersion,
        id: crypto.randomUUID(),
        issuedAt: Date.now(),
        senderId,
        // `'settings'` is written explicitly rather than left implicit, so a
        // message this build wrote and one an older build wrote stay tellable
        // apart by presence of the field alone -- `isLiveEditMessage` reads
        // absence as `'settings'` too, but only for what it did not write.
        kind: patchSet.kind,
        patches: patchSet.patches,
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
  apply: (patchSet: LiveEditPatchSet) => void,
): () => void {
  connected = transport;
  const unsubscribe = transport.subscribe((patchSet) => {
    applyingRemote = true;
    try {
      apply(patchSet);
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

/** Sends a patch set to the group, or does nothing at all when it has not opted in. */
export function publishLiveEdit(patchSet: LiveEditPatchSet): void {
  if (connected === null || applyingRemote || patchSet.patches.length === 0) return;
  connected.publish(patchSet);
}

function isApplicablePatch(patch: SettingsPatch): boolean {
  const definition = getSettingDefinition(patch.id);
  return definition !== undefined && definition.validate(patch.value);
}

/**
 * A content patch is applicable under the same reading `isApplicablePatch`
 * gives a settings one: a field this build still declares, an entity the
 * seed still holds -- `seedContentValue` is undefined for anything else --
 * and a value that field's own validator accepts.
 */
function isApplicableContentPatch(patch: ContentPatch): boolean {
  const definition = getContentFieldDefinition(patch.id);
  if (definition === undefined) return false;
  if (seedContentValue(patch.id, patch.entityId) === undefined) return false;
  return definition.validate(patch.value);
}

/** The typed, filtered patch set a decoded message carries, or none of it usable. */
function toPatchSet(message: LiveEditMessage): LiveEditPatchSet | null {
  if (message.kind === 'content') {
    const patches = (message.patches as readonly ContentPatch[]).filter(isApplicableContentPatch);
    return patches.length === 0 ? null : { kind: 'content', patches };
  }
  const patches = (message.patches as readonly SettingsPatch[]).filter(isApplicablePatch);
  return patches.length === 0 ? null : { kind: 'settings', patches };
}

function isLiveEditMessage(value: unknown): value is LiveEditMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    protocol?: unknown;
    id?: unknown;
    senderId?: unknown;
    kind?: unknown;
    patches?: unknown;
  };
  return (
    candidate.protocol === screenBusProtocolVersion &&
    typeof candidate.id === 'string' &&
    typeof candidate.senderId === 'string' &&
    (candidate.kind === undefined ||
      candidate.kind === 'settings' ||
      candidate.kind === 'content') &&
    Array.isArray(candidate.patches) &&
    candidate.patches.every(isPatchShape)
  );
}

/**
 * Loose on purpose, for both patch kinds: a settings patch needs only `id`
 * to reach `isApplicablePatch`, and a content patch's `entityId`/`value` are
 * validated there too, by `isApplicableContentPatch`. Neither field is
 * required here, so a shape check that passed a settings patch keeps passing
 * a content one.
 */
function isPatchShape(value: unknown): value is SettingsPatch | ContentPatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
