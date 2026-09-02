import {
  browserStorage,
  type KeyValueStorage,
} from '@/infrastructure/controlPlane/DeviceSessionStore';

import {
  parseControlPlaneAddressList,
  safeParseControlPlaneUrl,
  validateControlPlaneAddresses,
} from './controlPlaneLinks';

/**
 * The operator's own control-plane address, entered directly in the pairing
 * dialog (F14, R27 follow-up: the dialog's own hint used to name a control
 * plane address as the way out of local-only and offer no field to write one
 * in).
 *
 * Device-scoped, like the paired session itself: persisted under its own
 * `localStorage` key rather than folded into `project.override.json` or
 * `NEXT_PUBLIC_HQ_CONTROL_PLANE_URL`, because it is the one of the three
 * sources that is set from inside the running application instead of edited
 * on disk or baked into the build before launch. `ControlPlaneRuntime` reads
 * it ahead of both of the others -- it is the operator's explicit, most
 * recent statement of where the group is.
 */
export const manualControlPlaneAddressStorageKey = 'gremuchaya-hq:control-plane-address:v1';

export type ManualControlPlaneAddressOutcome =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly message: string };

const noAddresses: readonly string[] = [];
const listeners = new Set<() => void>();

/**
 * The saved address list, or `[]` when there is none or the blob does not
 * validate.
 *
 * Read fresh from storage on every call rather than cached at module scope:
 * a cache would go stale the moment something else touches `localStorage`
 * directly -- which every test file in this application already does in its
 * own `beforeEach` -- and a store that must be told about a clear it did not
 * perform is a store no caller can trust. The one piece of state this module
 * does hold is the listener set `subscribeManualControlPlaneAddress` manages,
 * which exists for reactivity and carries no value of its own to go stale.
 *
 * Validated through `controlPlaneUrl`'s own schema, the same one
 * `project.override.json` is checked against: a hand-edited or truncated
 * blob is read as no address at all, exactly as `DeviceSessionStore` reads a
 * damaged session as no session.
 */
export function readManualControlPlaneAddress(
  storage: KeyValueStorage = browserStorage(),
): readonly string[] {
  let raw: string | null;
  try {
    raw = storage.getItem(manualControlPlaneAddressStorageKey);
  } catch {
    return noAddresses;
  }
  if (raw === null) return noAddresses;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return noAddresses;
  }
  const result = safeParseControlPlaneUrl(parsed);
  return result.success ? result.data : noAddresses;
}

/**
 * Validates and persists the operator's address(es), typed as one
 * comma-separated field the way `project.override.json` already accepts
 * `controlPlaneUrl`.
 *
 * The same rule the project schema enforces -- one to four unique http(s)
 * URLs, none of them carrying credentials -- reused rather than restated, so
 * the in-app field can never accept an address the file would refuse. An
 * empty save is refused rather than treated as a clear: `set` and `clear` are
 * two different operator intentions, and conflating them would make "save an
 * empty field" silently equivalent to "forget the address", the one outcome
 * `clearManualControlPlaneAddress` exists to make deliberate.
 *
 * A repeated address is now refused rather than collapsed. The refusal below
 * has always ended `БЕЗ ПОВТОРОВ`, and the field could not enforce it while it
 * deduplicated the list before the schema saw it: the promise was in the text
 * and nowhere else.
 */
export function writeManualControlPlaneAddress(
  raw: string,
  storage: KeyValueStorage = browserStorage(),
): ManualControlPlaneAddressOutcome {
  const addresses = parseControlPlaneAddressList(raw);
  if (addresses.length === 0) {
    return { ok: false, message: 'УКАЖИТЕ ХОТЯ БЫ ОДИН АДРЕС CONTROL PLANE' };
  }
  const outcome = validateControlPlaneAddresses(addresses);
  if (!outcome.ok) {
    return {
      ok: false,
      message:
        'АДРЕС ДОЛЖЕН БЫТЬ HTTP(S) URL БЕЗ УЧЁТНЫХ ДАННЫХ. НЕ БОЛЕЕ ЧЕТЫРЁХ АДРЕСОВ, БЕЗ ПОВТОРОВ.',
    };
  }
  try {
    storage.setItem(manualControlPlaneAddressStorageKey, JSON.stringify(outcome.addresses));
  } catch {
    // Storage blocked or full. The value lives for this process only, the
    // same trade-off `DeviceSessionStore.write` makes for the paired session.
  }
  notify();
  return { ok: true, addresses: outcome.addresses };
}

/** Forgets the manual address; resolution falls through to the project file and the build variable. */
export function clearManualControlPlaneAddress(storage: KeyValueStorage = browserStorage()): void {
  try {
    storage.removeItem(manualControlPlaneAddressStorageKey);
  } catch {
    // Nothing to recover.
  }
  notify();
}

/**
 * Notifies a listener every time `writeManualControlPlaneAddress` or
 * `clearManualControlPlaneAddress` runs, so `ControlPlaneRuntime` can re-run
 * its connect effect the moment the operator changes the address -- the same
 * reason `subscribeControlPlaneSession` exists beside `currentControlPlaneSession`.
 * Carries no snapshot of its own; a caller that needs the current value reads
 * it with {@link readManualControlPlaneAddress} the way every other listener
 * in this module's family does.
 */
export function subscribeManualControlPlaneAddress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}
