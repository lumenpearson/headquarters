import { getSettingDefinition, settingsDefinitions } from '@gremuchaya/settings-schema';
import type { SettingsPatch, SettingValue } from '@gremuchaya/settings-schema';

import { isControlPlaneError } from './controlPlanePort';
import type { GroupSettingsOperation, GroupSettingsPort } from './groupSettingsPort';

/**
 * The settings whose scope says they belong to the group, not the machine.
 *
 * Five today -- `telemetry.source`, `simulation.preset`, `groups.authority`,
 * `github.draftOnly`, `advanced.liveEdit` -- against 135 device ones. The list
 * is derived from the definitions rather than written out, so a sixth
 * group-scoped setting reaches the group the moment it is declared, and a
 * definition demoted to `device` stops reaching it.
 */
export function groupScopedSettingIds(): readonly string[] {
  return settingsDefinitions
    .filter((definition) => definition.scope === 'group')
    .map((definition) => definition.id);
}

export function isGroupScopedSetting(id: string): boolean {
  return getSettingDefinition(id)?.scope === 'group';
}

export interface GroupSettingsSyncOptions {
  readonly port: GroupSettingsPort;
  /**
   * Lands the group's values in the local draft. The store's
   * `applySettingsPatch`, in the app; it is passed in rather than reached for
   * so this service never imports the store that drives it.
   */
  readonly apply: (patches: readonly SettingsPatch[]) => void;
  /** The current draft values, so a join only patches what actually differs. */
  readonly readDraftValue: (id: string) => SettingValue | undefined;
  /** Where a refusal is recorded, in the operator's language. */
  readonly onFailure?: (message: string) => void;
}

/**
 * The group half of the settings (R6).
 *
 * **Precedence, decided here and stated once.** On join the group wins: the
 * values `GetEffectiveSettings` reports for the group are written into this
 * client's draft, overwriting whatever it held. Joining a group is accepting
 * what the group agreed, and a session that kept its own telemetry source
 * after joining would be in the group by name only. After the join the local
 * change wins and travels: an operator moving a group-scoped control is the
 * group deciding something, so the change is applied as a draft patch and
 * published in the same act.
 *
 * **What stays here.** The client's own draft is never sent as a draft. The
 * server refuses `LOCAL_DRAFT` and `SESSION_PREVIEW` by design -- neither has
 * a row it could live in, because an unsent draft and a preview that dies with
 * the session are client states (`settings/service.ts`, `resolveScope`). So the
 * group scope's *server-side* draft is used as a staging step for one
 * publication and nothing more: `ApplyDraftPatch` then `PublishDraft`, in one
 * call pair, rather than a draft left open for another device to find.
 *
 * **`groups.authority` has two homes and that is deliberate.** The settings
 * document records what the group agreed; the group row is what the server
 * enforces in `assertSessionAuthority`. `ControlPlaneSession.reconcileAuthority`
 * keeps the row in step through `SetAuthorityMode`, and this service keeps the
 * document in step through the same patch. Writing only one of them would
 * leave the other stating the opposite.
 */
export class GroupSettingsSync {
  readonly #options: GroupSettingsSyncOptions;
  /**
   * Set while a value read from the group is being applied.
   *
   * The store action that lands a patch is the same one that would publish it,
   * exactly as on the live-edit bus, and a value applied from the group and
   * then published back is two sessions echoing each other for ever.
   */
  #applyingRemote = false;

  constructor(options: GroupSettingsSyncOptions) {
    this.#options = options;
  }

  get applyingRemote(): boolean {
    return this.#applyingRemote;
  }

  /**
   * Reads the group's agreed values and lands the ones that differ.
   *
   * `include_draft` is false: an unpublished group draft is somebody's edit in
   * progress, and a joining session adopting it would be following a decision
   * nobody has taken yet. A value the local catalogue cannot validate is
   * dropped -- the group may be running a newer build -- and the rest still
   * lands, which is the same rule the live-edit bus applies to the wire.
   */
  async adoptGroupSettings(signal?: AbortSignal): Promise<readonly SettingsPatch[]> {
    let document;
    try {
      document = await this.#options.port.getEffectiveSettings(false, signal);
    } catch (error: unknown) {
      this.#record(error, 'НАСТРОЙКИ ГРУППЫ НЕ ПРОЧИТАНЫ');
      return [];
    }
    const patches: SettingsPatch[] = [];
    for (const id of groupScopedSettingIds()) {
      const value = document.values[id];
      if (value === undefined) continue;
      const definition = getSettingDefinition(id);
      if (definition === undefined || !definition.validate(value)) continue;
      if (sameValue(this.#options.readDraftValue(id), value)) continue;
      patches.push({ id, value });
    }
    if (patches.length === 0) return [];
    this.#applyingRemote = true;
    try {
      this.#options.apply(patches);
    } finally {
      this.#applyingRemote = false;
    }
    return patches;
  }

  /**
   * Carries group-scoped changes to `SettingsService`.
   *
   * Device-scoped patches are filtered out rather than refused: one operator
   * gesture moves both kinds at once -- the settings screen applies whatever
   * the operator changed -- and only the group's share of it is the group's
   * business. A gesture that touched nothing group-scoped makes no call at all.
   */
  async publishGroupSettings(
    patches: readonly SettingsPatch[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.#applyingRemote) return false;
    const operations = toGroupOperations(patches);
    if (operations.length === 0) return false;
    try {
      await this.#options.port.applyGroupDraftPatch(operations, signal);
      await this.#options.port.publishGroupDraft(signal);
      return true;
    } catch (error: unknown) {
      this.#record(error, 'НАСТРОЙКА ГРУППЫ НЕ ПРИНЯТА');
      return false;
    }
  }

  #record(error: unknown, fallback: string): void {
    const onFailure = this.#options.onFailure;
    if (onFailure === undefined) return;
    if (isControlPlaneError(error, 'unimplemented')) {
      onFailure('CONTROL PLANE БЕЗ ХРАНИЛИЩА НАСТРОЕК — ГРУППОВЫЕ ЗНАЧЕНИЯ НЕДОСТУПНЫ');
      return;
    }
    if (isControlPlaneError(error, 'not-found')) {
      // The group has never published anything. That is the ordinary state of
      // a new group and not a failure worth putting on the status line.
      return;
    }
    const message = error instanceof Error ? error.message.trim() : '';
    onFailure(message.length === 0 ? fallback : `${fallback}: ${message}`);
  }
}

/**
 * The group's share of a patch, as `SettingsPatchOperation`s.
 *
 * A value its own definition rejects is dropped here rather than sent: the
 * server stores what it is given and would then serve a value no client can
 * read back.
 */
export function toGroupOperations(
  patches: readonly SettingsPatch[],
): readonly GroupSettingsOperation[] {
  const operations: GroupSettingsOperation[] = [];
  for (const patch of patches) {
    const definition = getSettingDefinition(patch.id);
    if (definition === undefined || definition.scope !== 'group') continue;
    if (!definition.validate(patch.value)) continue;
    operations.push({ path: patch.id, value: patch.value });
  }
  return operations;
}

function sameValue(left: SettingValue | undefined, right: SettingValue): boolean {
  if (left === undefined) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}
