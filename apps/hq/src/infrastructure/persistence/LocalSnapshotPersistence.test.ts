// @vitest-environment jsdom
import { appSnapshotSchema } from '@gremuchaya/config';
import { screenIds } from '@gremuchaya/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import { LocalSnapshotPersistence } from './LocalSnapshotPersistence';

const storageKey = 'gremuchaya-hq:snapshots:v1';

function rawSnapshot(name: string): Record<string, unknown> {
  return {
    version: 1,
    name,
    createdAt: '2026-08-21T10:00:00.000Z',
    sceneId: null,
    cueIndex: -1,
    screens: Object.fromEntries(
      screenIds.map((id) => [
        id,
        {
          id,
          module: 'idle',
          payload: {},
          blackout: false,
          standby: false,
          frozen: false,
          glitch: 0,
          revision: 0,
        },
      ]),
    ),
    explorer: {
      activePath: '/',
      selectedNodeId: null,
      expandedNodeIds: [],
      viewMode: 'list',
      searchQuery: '',
    },
    workspace: { activeSection: 'overview', windows: [], activeDocumentId: null },
    clock: { mode: 'real', fixedTime: '00:00:00' },
    wallPreset: 'DEFAULT',
    developerStateOverrides: {},
  };
}

describe('LocalSnapshotPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('recovers from a blob that is not JSON at all', async () => {
    localStorage.setItem(storageKey, 'not json');
    const persistence = new LocalSnapshotPersistence();

    await expect(persistence.list()).resolves.toEqual([]);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('drops an entry it cannot validate and keeps the rest', async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify([rawSnapshot('good'), { version: 99, name: 'from the future' }]),
    );
    const persistence = new LocalSnapshotPersistence();

    const listed = await persistence.list();

    expect(listed.map((snapshot) => snapshot.name)).toEqual(['good']);
  });

  it('can still save after a corrupt entry -- the defect this fixes', async () => {
    localStorage.setItem(storageKey, JSON.stringify([{ nonsense: true }]));
    const persistence = new LocalSnapshotPersistence();

    // Before the fix `save` read through `list`, so one unparseable entry made
    // saving impossible for good.
    await persistence.save(appSnapshotSchema.parse(rawSnapshot('rescued')));

    const listed = await persistence.list();
    expect(listed.map((snapshot) => snapshot.name)).toEqual(['rescued']);
  });
});
