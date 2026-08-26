import { getSettingDefinition } from '@gremuchaya/settings-schema';
import type { SettingsPatch } from '@gremuchaya/settings-schema';

import type { GroupChannel } from '@/application/sync/groupChannel';
import type { LiveEditTransport } from '@/infrastructure/browser/LiveEditBus';

/**
 * The document every live-edit delta is appended under.
 *
 * A fixed identifier rather than one per session: the group log is keyed by
 * document, and a subscriber filters on it, so two sessions editing settings
 * have to name the same document or neither hears the other. It is not a
 * `SettingsService` scope and does not pretend to be one -- this is the group
 * event log, and what it carries is an edit in flight rather than a published
 * value.
 */
export const liveEditDocumentId = 'settings.live-edit';

/** The envelope inside `delta`, so a future shape can be told from this one. */
const payloadProtocol = 1 as const;

interface LiveEditPayload {
  readonly protocol: typeof payloadProtocol;
  readonly patches: readonly SettingsPatch[];
}

export interface GroupLiveEditTransportOptions {
  readonly channel: GroupChannel;
  /**
   * Where a refused publication is reported. Publishing is fire-and-forget --
   * `LiveEditTransport.publish` answers nothing, because the browser bus it
   * was written for answers nothing either -- so a rejection has to leave by
   * some other door or vanish. A viewer role, a rate limit and an expired
   * token all arrive here.
   */
  readonly onPublishFailed?: (error: unknown) => void;
}

/**
 * Live edit over the authenticated transport (R27, F10 task 2).
 *
 * The same `LiveEditTransport` the browser bus implements, so `EditModeRuntime`
 * chooses between them and nothing downstream changes. What changes is reach:
 * `BroadcastChannel` carries a patch to other tabs of one browser profile,
 * while `PublishDocumentDelta` carries it to every admitted device in the
 * group, and back to this one as the echo of its own append.
 *
 * The gate does not move. `advanced.liveEdit` still decides whether a channel
 * exists at all, and it is group-scoped for the reason `LiveEditBus` states:
 * one operator flipping their own copy of the switch must not reach a session
 * that never agreed.
 */
export function createGroupLiveEditTransport(
  options: GroupLiveEditTransportOptions,
): LiveEditTransport {
  const { channel } = options;
  const listeners = new Set<(patches: readonly SettingsPatch[]) => void>();
  let closed = false;

  const unsubscribe = channel.subscribe((event) => {
    if (closed) return;
    if (event.kind !== 'document-delta' || event.documentId !== liveEditDocumentId) return;
    // The publisher hears its own append back from the log. Applying it would
    // land the patch twice and, through `applySettingsPatch`, write a second
    // history entry for one change.
    if (event.actorDeviceId === channel.deviceId) return;
    const payload = decodePayload(event.documentDelta);
    if (payload === null) return;
    // The wire is a trust boundary here exactly as it is on the browser bus:
    // `applyDraftPatch` throws on an unknown identifier or a value its
    // definition rejects, so a session running an older or newer catalogue
    // would otherwise take this one down rather than simply disagree with it.
    const patches = payload.patches.filter(isApplicablePatch);
    if (patches.length === 0) return;
    for (const listener of [...listeners]) listener(patches);
  });

  return {
    publish(patches) {
      if (closed || patches.length === 0) return;
      void channel
        .publishDocumentDelta({
          documentId: liveEditDocumentId,
          documentType: 'settings',
          delta: encodePayload(patches),
        })
        .catch((error: unknown) => {
          options.onPublishFailed?.(error);
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

function encodePayload(patches: readonly SettingsPatch[]): Uint8Array {
  const payload: LiveEditPayload = { protocol: payloadProtocol, patches };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodePayload(delta: Uint8Array): LiveEditPayload | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(delta));
    return isLiveEditPayload(parsed) ? parsed : null;
  } catch {
    // A delta some other publisher wrote under this document id, or a truncated
    // one. Neither is this transport's to interpret.
    return null;
  }
}

function isApplicablePatch(patch: SettingsPatch): boolean {
  const definition = getSettingDefinition(patch.id);
  return definition !== undefined && definition.validate(patch.value);
}

function isLiveEditPayload(value: unknown): value is LiveEditPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { protocol?: unknown; patches?: unknown };
  return (
    candidate.protocol === payloadProtocol &&
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
