import type { GroupChannel } from '@/application/sync/groupChannel';
import type { GroupSettingsPort } from '@/application/sync/groupSettingsPort';
import type { MaterialLibraryClient } from '@/infrastructure/materials/materialLibrary';

/**
 * The group's live collaborators, for the surfaces that need one.
 *
 * `ControlPlaneRuntime` already holds the session this way, and for the same
 * reason: the application runs as a single runtime, and threading a context
 * from the root layout into a video screen or an edit runtime mounted beside it
 * would be ceremony around one instance. `null` is both the default and the
 * disconnected state, so a surface that asks while nothing is connected is told
 * exactly that rather than handed a channel that cannot answer.
 *
 * Kept in its own module rather than in `ControlPlaneRuntime` so that a
 * consumer -- `EditModeRuntime`, `VideoScreen` -- imports a holder and not a
 * component: importing the runtime would drag the whole control-plane client
 * into every bundle that only wanted to know whether a group exists.
 */
export interface GroupRuntimeHandle {
  readonly groupId: string;
  readonly deviceId: string;
  readonly channel: GroupChannel;
  /** `null` on a control plane started without a settings store. */
  readonly settings: GroupSettingsPort | null;
  /**
   * The group's material library, or absent when this control plane answers
   * `GetCapabilities` without `materials`. `selectMaterialLibrary` reads it and
   * falls back to the loopback bridge, so nothing here is not a screen without
   * materials -- it is a screen whose materials stay on this machine.
   *
   * Optional rather than `| null`, unlike `settings`: a surface that only needs
   * a channel builds a handle without naming a collaborator it will never ask
   * for, and every reader goes through `selectMaterialLibrary`, which treats
   * absent and `null` as the same fact.
   */
  readonly materials?: MaterialLibraryClient | null;
}

let active: GroupRuntimeHandle | null = null;
const listeners = new Set<() => void>();

export function currentGroupRuntime(): GroupRuntimeHandle | null {
  return active;
}

export function setGroupRuntime(handle: GroupRuntimeHandle | null): void {
  if (active === handle) return;
  active = handle;
  for (const listener of [...listeners]) listener();
}

export function subscribeGroupRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server-render value: no group exists before the client mounts one. */
export function noGroupRuntime(): GroupRuntimeHandle | null {
  return null;
}
