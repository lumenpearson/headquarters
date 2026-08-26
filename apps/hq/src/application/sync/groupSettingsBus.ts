import type { SettingsPatch } from '@gremuchaya/settings-schema';

import type { GroupSettingsSync } from './GroupSettingsSync';

/*
 * One connection for the whole client, in the idiom `LiveEditBus` already uses
 * for live edit: the application runs as a single runtime, and threading a
 * context from the control-plane runtime down into the store would be ceremony
 * around one instance.
 *
 * `null` is the default and the disconnected state. With nothing connected
 * `publishGroupSettings` does nothing at all, which is what makes a local-only
 * session genuinely local rather than merely quiet -- there is no port for a
 * patch to reach.
 */
let connected: GroupSettingsSync | null = null;

/** Connects the group's settings until the returned function is called. */
export function connectGroupSettings(sync: GroupSettingsSync): () => void {
  connected = sync;
  return () => {
    // Only the connection this call opened is dropped: a reconnect that has
    // already replaced it must not be closed by the previous effect's cleanup.
    if (connected === sync) connected = null;
  };
}

/**
 * Carries the group's share of a patch to `SettingsService`, or does nothing.
 *
 * Called from `applySettingsPatch` beside `publishLiveEdit`, and for the same
 * reason: sending is an effect and a Zustand updater has to stay a pure
 * function of the previous state. The two are not alternatives. Live edit
 * carries an edit in flight over the group event log so other sessions see it
 * immediately; this records what the group agreed in the settings document, so
 * a session joining tomorrow reads it. A group with `advanced.liveEdit` off
 * still publishes here -- the opt-in governs live edit, not whether a
 * group-scoped setting is group-scoped.
 */
export function publishGroupSettings(patches: readonly SettingsPatch[]): void {
  if (connected === null || patches.length === 0) return;
  void connected.publishGroupSettings(patches);
}

/** The connected service, for a surface that has to await a publication. */
export function currentGroupSettingsSync(): GroupSettingsSync | null {
  return connected;
}
