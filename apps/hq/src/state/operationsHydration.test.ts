// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeOperationsClient, operationsStore } from './operationsStore';

const persistedStateKey = 'gremuchaya-hq:operations:v3';
const snapshotStateKey = 'gremuchaya-hq:production-snapshots:v3';

describe('initializeOperationsClient', () => {
  let dispose: () => void = () => undefined;

  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.setState((state) => ({
      production: { ...state.production, snapshots: [] },
    }));
  });

  afterEach(() => {
    dispose();
    dispose = () => undefined;
  });

  it('clears the snapshot key it could not read, not the state key', () => {
    localStorage.setItem(persistedStateKey, JSON.stringify({ version: 5 }));
    localStorage.setItem(snapshotStateKey, 'not json');

    dispose = initializeOperationsClient();

    // One shared catch used to remove `persistedStateKey`, so the corrupt
    // snapshot blob survived and threw again on every reload.
    expect(localStorage.getItem(snapshotStateKey)).toBeNull();
    expect(localStorage.getItem(persistedStateKey)).not.toBeNull();
  });

  it('refuses a snapshot list whose entries are not snapshots', () => {
    localStorage.setItem(snapshotStateKey, JSON.stringify([{ id: 'SNAP-1' }, 42]));

    dispose = initializeOperationsClient();

    expect(operationsStore.getState().production.snapshots).toEqual([]);
  });

  it('restores a well-formed snapshot list', () => {
    const snapshot = {
      id: 'SNAP-1',
      name: 'rehearsal',
      createdAt: '2026-08-21T10:00:00.000Z',
      route: 'overview',
      selectedObjectId: 'K-22',
      selectedCameraId: 'CAM-04',
      selectedCaseId: 'CASE-08',
      mapCenter: [55.75, 37.61],
      mapZoom: 12,
      mapLayers: operationsStore.getState().ui.mapLayers,
      activeAlertIds: [],
      preset: 'DEFAULT',
      simulationPaused: false,
      fixedTime: '12:00:00',
    };
    localStorage.setItem(snapshotStateKey, JSON.stringify([snapshot]));

    dispose = initializeOperationsClient();

    expect(operationsStore.getState().production.snapshots.map((entry) => entry.id)).toEqual([
      'SNAP-1',
    ]);
  });
});
