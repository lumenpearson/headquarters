import { getSettingDefinition, settingsDefinitions } from '@gremuchaya/settings-schema';
import type { SettingsPatch, SettingValue } from '@gremuchaya/settings-schema';

import { isControlPlaneError } from './controlPlanePort';
import type { GroupSettingsOperation, GroupSettingsPort } from './groupSettingsPort';
// Type-only, and it has to stay that way: `localMirror` imports
// `isGroupScopedSetting` from here as a value, and `verbatimModuleSyntax`
// erases this line, so the two modules never form a cycle at runtime.
import type { GroupMirrorPort } from './localMirror';

/**
 * The settings whose scope says they belong to the group, not the machine.
 *
 * The membership is derived from `settingsDefinitions`, never written out here:
 * a definition declared `scope: 'group'` reaches the group the moment it is
 * declared, and one demoted to `device` stops reaching it, with nothing to keep
 * in step. An earlier version of this comment named the five settings and the
 * count of the rest, and both were wrong within a release -- which is the
 * argument for naming the mechanism rather than the number.
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
  /**
   * The local copy of what the group agreed (F14, stage 9).
   *
   * Absent in a session that has none -- and the service then behaves exactly
   * as it did before there was one: it reads the group or it reads nothing.
   * With a copy present, the cloud's answer is offered to it on the way past,
   * and the copy is what a join falls back to when the cloud does not answer.
   */
  readonly mirror?: GroupMirrorPort;
  /**
   * Called once per join attempt, after the copy has had its chance to move.
   *
   * It carries no argument on purpose: the caller re-reads `mirror.read()`, so
   * there is one account of what the copy holds rather than one account and a
   * message about it.
   */
  readonly onMirrorChanged?: () => void;
  /**
   * How `watchGroupSettings` waits between reconnects, injected for tests the
   * way `RealtimeClient` injects its own timer. Defaults to `setTimeout`.
   */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Overrides {@link watchReconnectBackoffMs} for a test that cannot wait 15 s. */
  readonly watchBackoffMs?: readonly number[];
}

/**
 * Bounded backoff for `watchGroupSettings`'s reconnect, in the idiom
 * `RealtimeClient`'s socket uses. `WatchSettings` is a poll under the server's
 * own hood (`settings/service.ts`), so there is nothing urgent to recover --
 * a control plane down for a minute gains nothing from being asked every
 * second, and `adoptGroupSettings` still runs once the stream reopens.
 */
export const watchReconnectBackoffMs: readonly number[] = [1_000, 2_000, 5_000, 15_000];

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
    const values = await this.#readGroupValues(signal);
    const patches = values === null ? [] : groupValuePatches(values, this.#options.readDraftValue);
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
   * Follows the group's published document live (R6).
   *
   * `WatchSettings` is server-streaming and, server-side, restricted to the
   * *effective* document (`GroupSettingsWatchEvent`'s own doc comment), so
   * there is nothing to branch on here: any frame at all means the group
   * moved, and `adoptGroupSettings` is what applies that -- through the same
   * precedence and the same mirror offer a join uses, run again rather than
   * duplicated. Without this a value another device published only reached
   * this session at the next login; `ControlPlaneRuntime`'s comment on
   * mounting "the sockets, the event channel and the group's settings" is
   * what this method is for.
   *
   * Runs until `signal` aborts. A stream that ends or fails is reopened after
   * {@link watchReconnectBackoffMs}, resuming from the highest revision seen
   * so far -- `0` on the first attempt, which asks for everything the scope
   * still holds a version row for.
   */
  async watchGroupSettings(signal?: AbortSignal): Promise<void> {
    const schedule =
      this.#options.schedule ??
      ((callback: () => void, delayMs: number) => {
        const timeoutId = setTimeout(callback, delayMs);
        return () => clearTimeout(timeoutId);
      });
    const backoffMs = this.#options.watchBackoffMs ?? watchReconnectBackoffMs;
    // A function rather than a narrowed boolean: `signal.aborted` moves after
    // this method has already read it once, and TypeScript's control-flow
    // narrowing does not know that -- it would otherwise treat every read
    // after the loop guard as the same (`false`) value for ever.
    const aborted = () => signal?.aborted === true;
    let afterRevision = 0;
    let attempt = 0;
    while (!aborted()) {
      let sawEvent = false;
      try {
        for await (const event of this.#options.port.watchSettings(afterRevision, signal)) {
          if (aborted()) return;
          sawEvent = true;
          attempt = 0;
          afterRevision = Math.max(afterRevision, event.revision);
          await this.adoptGroupSettings(signal);
        }
      } catch {
        // A dropped stream is not a failure worth the status line: it is
        // retried below, and `adoptGroupSettings` already reported its own
        // read failures through `#record` while the stream was open.
      }
      if (aborted()) return;
      if (!sawEvent) attempt = Math.min(attempt + 1, backoffMs.length - 1);
      await waitFor(backoffMs[attempt] ?? 0, signal, schedule);
    }
  }

  /**
   * What the group says, from the cloud if it answers and from the local copy
   * if it does not.
   *
   * **The order is the seniority the whole stage is about** -- cloud, then
   * local copy, then (by simply doing nothing) the compiled-in constants the
   * draft already holds. The cloud's answer is offered to the copy on the way
   * past; whether the copy takes it is the copy's decision and not this
   * service's, because "is this newer than what I have" is a question only the
   * copy has both sides of.
   *
   * A failed read is silence and never a rollback. Nothing about the draft or
   * the copy is worse afterwards than it was before the call: at worst the
   * session goes on holding what it already held.
   */
  async #readGroupValues(
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, SettingValue>> | null> {
    try {
      const document = await this.#options.port.getEffectiveSettings(false, signal);
      await this.#options.mirror?.absorb(document, signal);
      return document.values;
    } catch (error: unknown) {
      this.#record(error, 'НАСТРОЙКИ ГРУППЫ НЕ ПРОЧИТАНЫ');
      return this.#options.mirror?.read()?.values ?? null;
    } finally {
      this.#options.onMirrorChanged?.();
    }
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

  /**
   * Carries a local reset to the group, one `ResetElement` call per id (R6).
   *
   * `resetSettingsCategory` and `resetAllSettings` reset the *local* draft to
   * `defaultValue`, which is the right answer for a machine that has no group.
   * For the ids a group is in charge of, writing that default back as an
   * override through `applyGroupDraftPatch` would be the wrong RPC: a reset is
   * a request to *forget* the group's own value, not to publish a copy of the
   * factory one, and a theme layer supplying a non-factory default would make
   * the two answers differ. `resetGroupElement` is the RPC that forgets, so
   * resetting several ids at once is several calls to it rather than one to
   * `publishGroupSettings`. Ids the local catalogue does not say `scope:
   * 'group'` for are dropped, for the reason `publishGroupSettings` gives: a
   * category or a full reset touches both kinds of setting in one gesture, and
   * only the group's share of it is the group's business.
   */
  async publishGroupResets(ids: readonly string[], signal?: AbortSignal): Promise<boolean> {
    if (this.#applyingRemote) return false;
    const targets = ids.filter(isGroupScopedSetting);
    if (targets.length === 0) return false;
    try {
      for (const id of targets) {
        await this.#options.port.resetGroupElement(id, signal);
      }
      return true;
    } catch (error: unknown) {
      this.#record(error, 'СБРОС ГРУППЫ НЕ ПРИНЯТ');
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
 * The group's values as patches against this machine's draft.
 *
 * One rule with two callers, and that is the point of it being a function.
 * `adoptGroupSettings` applies it to what `GetEffectiveSettings` answered;
 * `ControlPlaneRuntime` applies it to what the local copy holds when the
 * control plane cannot be reached at all. Two loops would be two chances for
 * the offline path to accept something the online path refuses.
 *
 * A value the group does not hold is skipped, so a record with no values at
 * all produces no patches and every caller of this function is a no-op on one.
 *
 * That is load-bearing rather than incidental. A control plane whose database
 * was replaced -- a Neon project re-provisioned, migrations run against a fresh
 * branch -- answers `GetEffectiveSettings` for a group that holds nothing, and
 * adopting "nothing" as the group's decision would blank every group-scoped
 * setting on every joined device. Absent is not a decision.
 * `GroupSettingsSync.test.ts` holds the case.
 */
export function groupValuePatches(
  values: Readonly<Record<string, SettingValue>>,
  readDraftValue: (id: string) => SettingValue | undefined,
): readonly SettingsPatch[] {
  const patches: SettingsPatch[] = [];
  for (const id of groupScopedSettingIds()) {
    const value = values[id];
    if (value === undefined) continue;
    const definition = getSettingDefinition(id);
    if (definition === undefined || !definition.validate(value)) continue;
    if (sameValue(readDraftValue(id), value)) continue;
    patches.push({ id, value });
  }
  return patches;
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

/**
 * Resolves after `delayMs`, or as soon as `signal` aborts -- whichever is
 * first. `watchGroupSettings`'s reconnect loop is the only caller: an abort
 * mid-wait must not hold the loop open for the rest of the backoff.
 */
function waitFor(
  delayMs: number,
  signal: AbortSignal | undefined,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<void> {
  if (delayMs <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const cancel = schedule(resolve, delayMs);
    if (signal === undefined) return;
    signal.addEventListener(
      'abort',
      () => {
        cancel();
        resolve();
      },
      { once: true },
    );
  });
}
