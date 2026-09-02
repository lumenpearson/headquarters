import { getSettingDefinition, settingsDefinitions } from '@gremuchaya/settings-schema';
import type { SettingsPatch, SettingValue } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import { ControlPlaneError } from './controlPlanePort';
import type {
  GroupSettingsDocument,
  GroupSettingsHistoryPage,
  GroupSettingsOperation,
  GroupSettingsPort,
  GroupSettingsWatchEvent,
} from './groupSettingsPort';
import { groupScopedSettingIds, GroupSettingsSync, toGroupOperations } from './GroupSettingsSync';
import type { GroupMirror, GroupMirrorOutcome, GroupMirrorPort } from './localMirror';

/**
 * A settings service stated as a port, not a mock counting calls.
 *
 * The precedence claims are about *which values move in which direction*, and
 * only a port that holds both the group's document and the operations it was
 * sent can answer them: a spy on `applyDraftPatch` would pass while the device
 * scope's values were what travelled.
 */
class FakeGroupSettings implements GroupSettingsPort {
  readonly applied: (readonly GroupSettingsOperation[])[] = [];
  readonly resets: string[] = [];
  publishes = 0;
  readError: unknown = null;
  writeError: unknown = null;
  resetError: unknown = null;
  document: GroupSettingsDocument = {
    revision: 4,
    values: {},
    updatedAt: '2026-08-26T09:00:00.000Z',
  };
  /** What `watchSettings` yields, one array of events per call it receives. */
  watchTicks: (readonly GroupSettingsWatchEvent[])[] = [];
  /** Thrown after the last configured tick is exhausted, if set. */
  watchError: unknown = null;
  readonly watchedFrom: number[] = [];

  async getEffectiveSettings(): Promise<GroupSettingsDocument> {
    if (this.readError !== null) throw this.readError;
    return this.document;
  }

  async applyGroupDraftPatch(
    operations: readonly GroupSettingsOperation[],
  ): Promise<GroupSettingsDocument> {
    if (this.writeError !== null) throw this.writeError;
    this.applied.push(operations);
    return this.document;
  }

  async publishGroupDraft(): Promise<GroupSettingsDocument> {
    if (this.writeError !== null) throw this.writeError;
    this.publishes += 1;
    return this.document;
  }

  async resetGroupElement(elementId: string): Promise<GroupSettingsDocument> {
    if (this.resetError !== null) throw this.resetError;
    this.resets.push(elementId);
    return this.document;
  }

  async listGroupHistory(): Promise<GroupSettingsHistoryPage> {
    return { entries: [], nextCursor: '', hasMore: false };
  }

  async *watchSettings(afterRevision: number): AsyncIterable<GroupSettingsWatchEvent> {
    this.watchedFrom.push(afterRevision);
    const tick = this.watchTicks.shift();
    if (tick === undefined) {
      if (this.watchError !== null) throw this.watchError;
      return;
    }
    for (const event of tick) yield event;
  }
}

function sync(
  port: FakeGroupSettings,
  draft: Record<string, SettingValue> = {},
): {
  readonly service: GroupSettingsSync;
  readonly applied: (readonly SettingsPatch[])[];
  readonly failures: string[];
} {
  const applied: (readonly SettingsPatch[])[] = [];
  const failures: string[] = [];
  const service = new GroupSettingsSync({
    port,
    apply: (patches) => {
      applied.push(patches);
      for (const patch of patches) draft[patch.id] = patch.value as SettingValue;
    },
    readDraftValue: (id) => draft[id],
    onFailure: (message) => failures.push(message),
  });
  return { service, applied, failures };
}

describe('groupScopedSettingIds', () => {
  it('names every definition whose scope says group and no other', () => {
    const ids = groupScopedSettingIds();
    // Derived from the definitions rather than listed, so this asserts the
    // property and not a snapshot: a group-scoped setting declared tomorrow
    // must reach the group without anyone remembering to edit a list.
    expect(ids.every((id) => getSettingDefinition(id)?.scope === 'group')).toBe(true);
    expect(
      settingsDefinitions
        .filter((definition) => definition.scope === 'group')
        .every((definition) => ids.includes(definition.id)),
    ).toBe(true);
  });

  it('carries the settings R6 named as the group half, and no device setting', () => {
    const ids = groupScopedSettingIds();
    for (const id of [
      'telemetry.source',
      'simulation.preset',
      'groups.authority',
      'github.draftOnly',
      'advanced.liveEdit',
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('layout.density');
  });
});

describe('GroupSettingsSync precedence', () => {
  it('lets the group win on join, overwriting what this machine held', async () => {
    const port = new FakeGroupSettings();
    port.document = {
      revision: 4,
      values: { 'telemetry.source': 'native', 'advanced.liveEdit': true },
      updatedAt: '',
    };
    const test = sync(port, { 'telemetry.source': 'simulation', 'advanced.liveEdit': false });

    const patches = await test.service.adoptGroupSettings();

    expect(patches).toEqual([
      { id: 'telemetry.source', value: 'native' },
      { id: 'advanced.liveEdit', value: true },
    ]);
    expect(test.applied).toHaveLength(1);
  });

  /*
   * The guard against the failure this task exists to prevent, from the
   * settings side. A control plane whose database was replaced -- a Neon
   * project re-provisioned, migrations run against a fresh branch -- answers
   * for a group that holds nothing at all. Adopting "nothing" as the group's
   * decision would blank every group-scoped setting on every joined device, and
   * the operator would learn about the reset by losing their configuration.
   *
   * Nothing is adopted, nothing is applied, and the local values are still the
   * local values afterwards.
   */
  it('adopts nothing at all from a group that holds no values', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 0, values: {}, updatedAt: '' };
    const draft: Record<string, SettingValue> = {
      'telemetry.source': 'native',
      'advanced.liveEdit': true,
      'simulation.preset': 'degraded',
    };
    const test = sync(port, draft);

    expect(await test.service.adoptGroupSettings()).toEqual([]);

    expect(test.applied).toEqual([]);
    expect(draft).toEqual({
      'telemetry.source': 'native',
      'advanced.liveEdit': true,
      'simulation.preset': 'degraded',
    });
  });

  /*
   * The same rule one setting at a time: a group that holds some group-scoped
   * values and not others may decide the ones it holds and nothing more. An
   * implementation that read a missing value as the definition's default would
   * pass the whole-document case above and still reset a setting here.
   */
  it('leaves a group-scoped setting the group does not hold alone', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 4, values: { 'telemetry.source': 'native' }, updatedAt: '' };
    const draft: Record<string, SettingValue> = {
      'telemetry.source': 'simulation',
      'advanced.liveEdit': true,
    };
    const test = sync(port, draft);

    const patches = await test.service.adoptGroupSettings();

    expect(patches).toEqual([{ id: 'telemetry.source', value: 'native' }]);
    expect(draft['advanced.liveEdit']).toBe(true);
  });

  it('patches nothing when the group already agrees with the draft', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 4, values: { 'telemetry.source': 'native' }, updatedAt: '' };
    const test = sync(port, { 'telemetry.source': 'native' });

    expect(await test.service.adoptGroupSettings()).toEqual([]);
    expect(test.applied).toEqual([]);
  });

  it('leaves a device-scoped value the group happens to hold alone', async () => {
    const port = new FakeGroupSettings();
    port.document = {
      revision: 4,
      values: { 'layout.density': 'comfortable', 'telemetry.source': 'native' },
      updatedAt: '',
    };
    const test = sync(port, { 'layout.density': 'dense', 'telemetry.source': 'simulation' });

    const patches = await test.service.adoptGroupSettings();

    expect(patches).toEqual([{ id: 'telemetry.source', value: 'native' }]);
  });

  it('drops a group value the local catalogue cannot validate and keeps the rest', async () => {
    const port = new FakeGroupSettings();
    port.document = {
      revision: 4,
      values: { 'telemetry.source': 'quantum', 'simulation.preset': 'degraded' },
      updatedAt: '',
    };
    const test = sync(port, {});

    const patches = await test.service.adoptGroupSettings();

    expect(patches).toEqual([{ id: 'simulation.preset', value: 'degraded' }]);
  });

  it('does not publish back what it has just adopted', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 4, values: { 'telemetry.source': 'native' }, updatedAt: '' };
    const draft: Record<string, SettingValue> = { 'telemetry.source': 'simulation' };
    const applied: (readonly SettingsPatch[])[] = [];
    const service = new GroupSettingsSync({
      port,
      // The store action that lands a patch is the one that would publish it,
      // so the guard is exercised here exactly as the store exercises it.
      apply: (patches) => {
        applied.push(patches);
        void service.publishGroupSettings(patches);
      },
      readDraftValue: (id) => draft[id],
    });

    await service.adoptGroupSettings();

    expect(applied).toHaveLength(1);
    expect(port.applied).toEqual([]);
    expect(port.publishes).toBe(0);
  });
});

describe('GroupSettingsSync publication', () => {
  it('applies then publishes the group share of a patch', async () => {
    const port = new FakeGroupSettings();
    const test = sync(port);

    const published = await test.service.publishGroupSettings([
      { id: 'telemetry.source', value: 'hybrid' },
      { id: 'layout.density', value: 'comfortable' },
    ]);

    expect(published).toBe(true);
    expect(port.applied).toEqual([[{ path: 'telemetry.source', value: 'hybrid' }]]);
    expect(port.publishes).toBe(1);
  });

  it('makes no call for a gesture that touched nothing group-scoped', async () => {
    const port = new FakeGroupSettings();
    const test = sync(port);

    expect(
      await test.service.publishGroupSettings([{ id: 'layout.density', value: 'comfortable' }]),
    ).toBe(false);
    expect(port.applied).toEqual([]);
    expect(port.publishes).toBe(0);
  });

  it('reports a control plane without a settings store rather than retrying', async () => {
    const port = new FakeGroupSettings();
    port.writeError = new ControlPlaneError('unimplemented', 'no settings store');
    const test = sync(port);

    expect(
      await test.service.publishGroupSettings([{ id: 'telemetry.source', value: 'hybrid' }]),
    ).toBe(false);
    expect(test.failures).toEqual([
      'CONTROL PLANE БЕЗ ХРАНИЛИЩА НАСТРОЕК — ГРУППОВЫЕ ЗНАЧЕНИЯ НЕДОСТУПНЫ',
    ]);
  });

  it('says nothing when a group has simply never published anything', async () => {
    const port = new FakeGroupSettings();
    port.readError = new ControlPlaneError('not-found', 'no document');
    const test = sync(port);

    expect(await test.service.adoptGroupSettings()).toEqual([]);
    expect(test.failures).toEqual([]);
  });
});

describe('GroupSettingsSync.publishGroupResets', () => {
  it('resets each group-scoped id through ResetElement and skips a device-scoped one', async () => {
    const port = new FakeGroupSettings();
    const test = sync(port);

    const published = await test.service.publishGroupResets([
      'telemetry.source',
      'layout.density',
      'simulation.preset',
    ]);

    expect(published).toBe(true);
    // Order preserved, and never as a value written through `applyGroupDraftPatch`:
    // a reset forgets the group's override rather than republishing a default.
    expect(port.resets).toEqual(['telemetry.source', 'simulation.preset']);
    expect(port.applied).toEqual([]);
  });

  it('makes no call for ids that are all device-scoped', async () => {
    const port = new FakeGroupSettings();
    const test = sync(port);

    expect(await test.service.publishGroupResets(['layout.density'])).toBe(false);
    expect(port.resets).toEqual([]);
  });

  it('reports a control plane without a settings store rather than retrying', async () => {
    const port = new FakeGroupSettings();
    port.resetError = new ControlPlaneError('unimplemented', 'no settings store');
    const test = sync(port);

    expect(await test.service.publishGroupResets(['telemetry.source'])).toBe(false);
    expect(test.failures).toEqual([
      'CONTROL PLANE БЕЗ ХРАНИЛИЩА НАСТРОЕК — ГРУППОВЫЕ ЗНАЧЕНИЯ НЕДОСТУПНЫ',
    ]);
  });
});

describe('GroupSettingsSync.watchGroupSettings', () => {
  /**
   * A `schedule` that never actually waits: it resolves the reconnect delay
   * on the same tick, so the loop runs to the abort this fake also triggers
   * instead of a test waiting on real backoff timers.
   */
  function immediateSchedule(onCall: (attempt: number) => void) {
    let calls = 0;
    return (callback: () => void): (() => void) => {
      calls += 1;
      onCall(calls);
      callback();
      return () => undefined;
    };
  }

  it('adopts the group value for every event the stream yields', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 5, values: { 'telemetry.source': 'native' }, updatedAt: '' };
    port.watchTicks = [[{ revision: 5 }]];
    const draft: Record<string, SettingValue> = { 'telemetry.source': 'simulation' };
    const applied: (readonly SettingsPatch[])[] = [];
    const controller = new AbortController();
    const service = new GroupSettingsSync({
      port,
      apply: (patches) => {
        applied.push(patches);
        for (const patch of patches) draft[patch.id] = patch.value as SettingValue;
      },
      readDraftValue: (id) => draft[id],
      // Aborted from inside the reconnect wait that follows the one tick
      // configured above, so the loop makes exactly one pass.
      schedule: immediateSchedule(() => controller.abort()),
    });

    await service.watchGroupSettings(controller.signal);

    expect(applied).toEqual([[{ id: 'telemetry.source', value: 'native' }]]);
    expect(port.watchedFrom).toEqual([0]);
  });

  it('resumes a reconnect from the highest revision the dropped stream reached', async () => {
    const port = new FakeGroupSettings();
    port.watchTicks = [[{ revision: 7 }, { revision: 9 }]];
    const controller = new AbortController();
    const service = new GroupSettingsSync({
      port,
      apply: () => undefined,
      readDraftValue: () => undefined,
      // The first reconnect wait (after the configured tick ends) is let
      // through; the second (after the now-empty second connection) aborts.
      schedule: immediateSchedule((attempt) => {
        if (attempt >= 2) controller.abort();
      }),
    });

    await service.watchGroupSettings(controller.signal);

    expect(port.watchedFrom).toEqual([0, 9]);
  });

  it('retries after the stream throws instead of rejecting the caller', async () => {
    const port = new FakeGroupSettings();
    port.watchError = new Error('stream reset');
    const controller = new AbortController();
    const service = new GroupSettingsSync({
      port,
      apply: () => undefined,
      readDraftValue: () => undefined,
      schedule: immediateSchedule(() => controller.abort()),
    });

    await expect(service.watchGroupSettings(controller.signal)).resolves.toBeUndefined();
    expect(port.watchedFrom).toEqual([0]);
  });
});

/**
 * The local copy as a port, not a spy.
 *
 * The claims below are about *which of two sources the draft is filled from*,
 * so the fake has to be able to hold values and to answer a refusal, which a
 * call counter cannot.
 */
class FakeMirror implements GroupMirrorPort {
  copy: GroupMirror | null = null;
  outcome: GroupMirrorOutcome = 'adopted';
  readonly offered: GroupSettingsDocument[] = [];

  read(): GroupMirror | null {
    return this.copy;
  }

  async absorb(document: GroupSettingsDocument): Promise<GroupMirrorOutcome> {
    this.offered.push(document);
    return this.outcome;
  }
}

function mirrorHolding(values: Readonly<Record<string, SettingValue>>): GroupMirror {
  return {
    version: 1,
    groupId: 'GRP-1',
    installationId: 'INST-1',
    revision: 4,
    sequence: 12,
    values,
    refreshedAt: '2026-08-26T09:00:00.000Z',
  };
}

function syncWithMirror(
  port: FakeGroupSettings,
  mirror: FakeMirror,
  draft: Record<string, SettingValue> = {},
): {
  readonly service: GroupSettingsSync;
  readonly applied: (readonly SettingsPatch[])[];
  readonly mirrorChanges: number;
} {
  const applied: (readonly SettingsPatch[])[] = [];
  const counter = { value: 0 };
  const service = new GroupSettingsSync({
    port,
    apply: (patches) => {
      applied.push(patches);
      for (const patch of patches) draft[patch.id] = patch.value as SettingValue;
    },
    readDraftValue: (id) => draft[id],
    mirror,
    onMirrorChanged: () => {
      counter.value += 1;
    },
  });
  return {
    service,
    applied,
    get mirrorChanges() {
      return counter.value;
    },
  };
}

describe('GroupSettingsSync and the local copy', () => {
  it('offers the group answer to the copy and still lets the group win the join', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 9, values: { 'telemetry.source': 'native' }, updatedAt: '' };
    const mirror = new FakeMirror();
    const test = syncWithMirror(port, mirror, { 'telemetry.source': 'simulation' });

    const patches = await test.service.adoptGroupSettings();

    expect(mirror.offered).toEqual([port.document]);
    expect(patches).toEqual([{ id: 'telemetry.source', value: 'native' }]);
    expect(test.mirrorChanges).toBe(1);
  });

  it('lets the group win the join even when the copy refuses to record it', async () => {
    const port = new FakeGroupSettings();
    port.document = { revision: 2, values: { 'telemetry.source': 'native' }, updatedAt: '' };
    const mirror = new FakeMirror();
    // The copy refuses because the answer is older than what it holds. That is
    // a decision about the disk and not about the live group: the server is
    // what the group currently says, and joining is accepting it.
    mirror.outcome = 'kept';
    const test = syncWithMirror(port, mirror, { 'telemetry.source': 'simulation' });

    expect(await test.service.adoptGroupSettings()).toEqual([
      { id: 'telemetry.source', value: 'native' },
    ]);
  });

  it('joins on the local copy when the group cannot be read at all', async () => {
    const port = new FakeGroupSettings();
    // A download cut off mid-way: the connection dropped, the promise rejected.
    port.readError = new ControlPlaneError('unavailable', 'socket hang up');
    const mirror = new FakeMirror();
    mirror.copy = mirrorHolding({ 'telemetry.source': 'native', 'simulation.preset': 'degraded' });
    const draft: Record<string, SettingValue> = {
      'telemetry.source': 'simulation',
      'simulation.preset': 'normal',
    };
    const test = syncWithMirror(port, mirror, draft);

    const patches = await test.service.adoptGroupSettings();

    expect(patches).toEqual([
      { id: 'telemetry.source', value: 'native' },
      { id: 'simulation.preset', value: 'degraded' },
    ]);
    expect(mirror.offered).toEqual([]);
    expect(test.mirrorChanges).toBe(1);
  });

  it('adopts nothing when the group cannot be read and there is no copy', async () => {
    const port = new FakeGroupSettings();
    port.readError = new ControlPlaneError('unavailable', 'socket hang up');
    const mirror = new FakeMirror();
    // Level three of the seniority: nothing is patched, so the draft is left
    // holding what `createFactorySnapshot()` put there.
    const draft: Record<string, SettingValue> = { 'telemetry.source': 'simulation' };
    const test = syncWithMirror(port, mirror, draft);

    expect(await test.service.adoptGroupSettings()).toEqual([]);
    expect(test.applied).toEqual([]);
    expect(draft).toEqual({ 'telemetry.source': 'simulation' });
  });

  it('puts the copy through the same check the wire goes through', async () => {
    const port = new FakeGroupSettings();
    port.readError = new ControlPlaneError('unavailable', 'no route to host');
    const mirror = new FakeMirror();
    // A copy that reached the disk from an older build, or was hand-edited in
    // devtools. `groupValuePatches` is the one road into the draft, and it
    // refuses each of these for the same reason it refuses them from the wire.
    mirror.copy = mirrorHolding({
      'telemetry.source': 'quantum',
      'simulation.periodSeconds': 999_999,
      'layout.density': 'comfortable',
      'simulation.preset': 'degraded',
    } as unknown as Record<string, SettingValue>);
    const draft: Record<string, SettingValue> = { 'layout.density': 'dense' };
    const test = syncWithMirror(port, mirror, draft);

    expect(await test.service.adoptGroupSettings()).toEqual([
      { id: 'simulation.preset', value: 'degraded' },
    ]);
    expect(draft['layout.density']).toBe('dense');
  });
});

describe('toGroupOperations', () => {
  it('refuses a value the setting definition rejects', () => {
    expect(toGroupOperations([{ id: 'telemetry.source', value: 'quantum' }])).toEqual([]);
  });

  it('refuses an identifier no definition names', () => {
    expect(toGroupOperations([{ id: 'settings.unknown.identifier', value: 1 }])).toEqual([]);
  });
});
