import { getSettingDefinition, settingsDefinitions } from '@gremuchaya/settings-schema';
import type { SettingsPatch, SettingValue } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import { ControlPlaneError } from './controlPlanePort';
import type {
  GroupSettingsDocument,
  GroupSettingsHistoryPage,
  GroupSettingsOperation,
  GroupSettingsPort,
} from './groupSettingsPort';
import { groupScopedSettingIds, GroupSettingsSync, toGroupOperations } from './GroupSettingsSync';

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
  publishes = 0;
  readError: unknown = null;
  writeError: unknown = null;
  document: GroupSettingsDocument = {
    revision: 4,
    values: {},
    updatedAt: '2026-08-26T09:00:00.000Z',
  };

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

  async resetGroupElement(): Promise<GroupSettingsDocument> {
    return this.document;
  }

  async listGroupHistory(): Promise<GroupSettingsHistoryPage> {
    return { entries: [], nextCursor: '', hasMore: false };
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
    // property and not a snapshot: a sixth group-scoped setting declared
    // tomorrow must reach the group without anyone remembering to edit a list.
    expect(ids.every((id) => getSettingDefinition(id)?.scope === 'group')).toBe(true);
    expect(
      settingsDefinitions
        .filter((definition) => definition.scope === 'group')
        .every((definition) => ids.includes(definition.id)),
    ).toBe(true);
  });

  it('carries the five R6 named as the group half, and no device setting', () => {
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

describe('toGroupOperations', () => {
  it('refuses a value the setting definition rejects', () => {
    expect(toGroupOperations([{ id: 'telemetry.source', value: 'quantum' }])).toEqual([]);
  });

  it('refuses an identifier no definition names', () => {
    expect(toGroupOperations([{ id: 'settings.unknown.identifier', value: 1 }])).toEqual([]);
  });
});
