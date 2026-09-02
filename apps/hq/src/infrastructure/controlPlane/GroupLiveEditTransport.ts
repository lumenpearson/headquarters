import { getSettingDefinition } from '@gremuchaya/settings-schema';
import type { SettingsPatch } from '@gremuchaya/settings-schema';

import { getContentFieldDefinition, seedContentValue } from '@/application/edit/contentFields';
import type { ContentPatch } from '@/application/edit/contentFields';
import type { GroupChannel } from '@/application/sync/groupChannel';
import type { LiveEditPatchSet, LiveEditTransport } from '@/infrastructure/browser/LiveEditBus';

/**
 * The document every live-edit delta is appended under.
 *
 * A fixed identifier rather than one per session: the group log is keyed by
 * document, and a subscriber filters on it, so two sessions editing settings
 * have to name the same document or neither hears the other. It is not a
 * `SettingsService` scope and does not pretend to be one -- this is the group
 * event log, and what it carries is an edit in flight rather than a published
 * value.
 *
 * One identifier for both patch kinds, settings and content: the id names the
 * log, not what is in it, `LiveEditPayload.kind` already tells the two apart
 * on the wire, and `SynchronizedDocumentType` on the envelope records which
 * for the server's own bookkeeping. A second document id would only buy a
 * second filter a subscriber already does by reading `kind`.
 */
export const liveEditDocumentId = 'settings.live-edit';

/** The envelope inside `delta`, so a future shape can be told from this one. */
const payloadProtocol = 1 as const;

/**
 * `kind` mirrors `LiveEditPatchSet`, and is absent for exactly the payload a
 * settings patch has always encoded: a peer running before content rode this
 * channel wrote no such field, and a payload without it is that peer's
 * settings patch, not an empty content one.
 */
interface SettingsLiveEditPayload {
  readonly protocol: typeof payloadProtocol;
  // Present and `undefined` rather than omitted, so `payload.kind === 'content'`
  // discriminates the union instead of erroring on a member that lacks the
  // property outright.
  readonly kind?: undefined;
  readonly patches: readonly SettingsPatch[];
}

interface ContentLiveEditPayload {
  readonly protocol: typeof payloadProtocol;
  readonly kind: 'content';
  readonly patches: readonly ContentPatch[];
}

type LiveEditPayload = SettingsLiveEditPayload | ContentLiveEditPayload;

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
 *
 * Domain-content edits (R4) ride the same channel as a `'content'`-kinded
 * `LiveEditPatchSet`, closing the gap the plan recorded against this file: a
 * date or a title corrected in a group with live edit on used to reach no
 * further than this session, because only settings patches had a wire shape
 * here. `EditModeRuntime` lands a received content patch through
 * `applyContentPatch`, the same action a local edit takes, so the receiving
 * session's undo stack gains its own entry for it rather than the whole
 * content-overrides set being replaced underneath the ledger.
 */
export function createGroupLiveEditTransport(
  options: GroupLiveEditTransportOptions,
): LiveEditTransport {
  const { channel } = options;
  const listeners = new Set<(patchSet: LiveEditPatchSet) => void>();
  let closed = false;

  const unsubscribe = channel.subscribe((event) => {
    if (closed) return;
    if (event.kind !== 'document-delta' || event.documentId !== liveEditDocumentId) return;
    // The publisher hears its own append back from the log. Applying it would
    // land the patch twice and, through `applySettingsPatch`/`applyContentPatch`,
    // write a second history entry for one change.
    if (event.actorDeviceId === channel.deviceId) return;
    const payload = decodePayload(event.documentDelta);
    if (payload === null) return;
    // The wire is a trust boundary here exactly as it is on the browser bus:
    // `applyDraftPatch` throws on an unknown identifier or a value its
    // definition rejects, so a session running an older or newer catalogue
    // would otherwise take this one down rather than simply disagree with it.
    const patchSet = toPatchSet(payload);
    if (patchSet === null) return;
    for (const listener of [...listeners]) listener(patchSet);
  });

  return {
    publish(patchSet) {
      if (closed || patchSet.patches.length === 0) return;
      void channel
        .publishDocumentDelta({
          documentId: liveEditDocumentId,
          documentType: patchSet.kind === 'content' ? 'content' : 'settings',
          delta: encodePayload(patchSet),
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

function encodePayload(patchSet: LiveEditPatchSet): Uint8Array {
  const payload: LiveEditPayload =
    patchSet.kind === 'content'
      ? { protocol: payloadProtocol, kind: 'content', patches: patchSet.patches }
      : { protocol: payloadProtocol, patches: patchSet.patches };
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

/** The content twin of `isApplicablePatch`, against the content field registry. */
function isApplicableContentPatch(patch: ContentPatch): boolean {
  const definition = getContentFieldDefinition(patch.id);
  if (definition === undefined) return false;
  if (seedContentValue(patch.id, patch.entityId) === undefined) return false;
  return definition.validate(patch.value);
}

/** The typed, filtered patch set a decoded payload carries, or none of it usable. */
function toPatchSet(payload: LiveEditPayload): LiveEditPatchSet | null {
  if (payload.kind === 'content') {
    const patches = payload.patches.filter(isApplicableContentPatch);
    return patches.length === 0 ? null : { kind: 'content', patches };
  }
  const patches = payload.patches.filter(isApplicablePatch);
  return patches.length === 0 ? null : { kind: 'settings', patches };
}

function isLiveEditPayload(value: unknown): value is LiveEditPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { protocol?: unknown; kind?: unknown; patches?: unknown };
  if (candidate.protocol !== payloadProtocol) return false;
  if (!Array.isArray(candidate.patches) || !candidate.patches.every(isPatchShape)) return false;
  return candidate.kind === undefined || candidate.kind === 'content';
}

function isPatchShape(value: unknown): value is SettingsPatch | ContentPatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}
