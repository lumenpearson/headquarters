// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import { initializeOperationsClient, operationsStore } from '@/state/operationsStore';

import {
  importedMaterialToAttachment,
  toImportedMaterial,
  toMaterialEntry,
} from './importedMaterials';

const persistedStateKey = 'gremuchaya-hq:operations:v3';

const entry: MaterialEntry = {
  materialId: '018f0f1a-8000-7000-8000-000000000000',
  displayName: 'camera-loop.mp4',
  mimeType: 'video/mp4',
  // Above `Number.MAX_SAFE_INTEGER` would be absurd for a file, but the type is
  // a bigint and the store's string form has to survive one that is merely
  // large.
  byteSize: 5_368_709_120n,
  contentHash: 'a'.repeat(64),
  createdAt: '2026-08-25T00:00:00.000Z',
};

describe('the record an import leaves behind', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.setState({ materials: { imported: {} } });
  });

  it('round-trips a library entry through the persisted form without losing its size', () => {
    const imported = toImportedMaterial(entry, {
      category: 'video',
      origin: 'group-library',
      importedAt: '2026-08-25T10:00:00.000Z',
    });

    expect(imported.byteSize).toBe('5368709120');
    expect(toMaterialEntry(imported)).toEqual(entry);
  });

  it('survives JSON, which a bigint would not', () => {
    const imported = toImportedMaterial(entry, {
      category: 'video',
      origin: 'local-mirror',
      importedAt: '2026-08-25T10:00:00.000Z',
    });

    // The whole reason `byteSize` is a decimal string: `JSON.stringify` throws
    // on a bigint rather than dropping it, so one imported material would have
    // taken the entire persisted blob down with it.
    expect(() => JSON.stringify({ imported })).not.toThrow();
    expect(() => JSON.stringify({ raw: entry })).toThrow(TypeError);
  });

  it('shows the operator where the bytes went and what they called it', () => {
    const attachment = importedMaterialToAttachment(
      toImportedMaterial(entry, {
        category: 'intercept',
        origin: 'group-library',
        importedAt: '2026-08-25T10:00:00.000Z',
      }),
    );

    expect(attachment.id).toBe(entry.materialId);
    expect(attachment.kind).toBe('video');
    expect(attachment.source).toBe('GROUP LIBRARY / GRPC-WEB');
    expect(attachment.tags).toEqual(['group-library', 'intercept', 'video/mp4']);
    expect(attachment.sizeLabel).toBe('5.00 GB');
  });

  it('is written to the store and outlives a world reset', () => {
    const imported = toImportedMaterial(entry, {
      category: 'video',
      origin: 'local-mirror',
      importedAt: '2026-08-25T10:00:00.000Z',
    });
    operationsStore.getState().recordImportedMaterial(imported);

    expect(operationsStore.getState().materials.imported[entry.materialId]).toEqual(imported);
    expect(operationsStore.getState().audit[0]?.entityId).toBe(entry.materialId);

    // A reset of the simulated world must not be the act that loses the record
    // of a real file the operator put somewhere.
    operationsStore.getState().resetWorld();
    expect(operationsStore.getState().materials.imported[entry.materialId]).toEqual(imported);

    operationsStore.getState().forgetImportedMaterial(entry.materialId);
    expect(operationsStore.getState().materials.imported).toEqual({});
  });

  it('replaces a repeat import of the same content rather than listing it twice', () => {
    const first = toImportedMaterial(entry, {
      category: 'other',
      origin: 'local-mirror',
      importedAt: '2026-08-25T10:00:00.000Z',
    });
    const second = toImportedMaterial(entry, {
      category: 'intercept',
      origin: 'local-mirror',
      importedAt: '2026-08-25T11:00:00.000Z',
    });
    operationsStore.getState().recordImportedMaterial(first);
    operationsStore.getState().recordImportedMaterial(second);

    expect(Object.keys(operationsStore.getState().materials.imported)).toEqual([entry.materialId]);
    expect(operationsStore.getState().materials.imported[entry.materialId]?.category).toBe(
      'intercept',
    );
  });
});

describe('imports across a launch', () => {
  let dispose: () => void = () => undefined;

  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.setState({ materials: { imported: {} } });
  });

  afterEach(() => {
    dispose();
    dispose = () => undefined;
  });

  it('comes back on the next launch, so the registry still points at the bytes', () => {
    dispose = initializeOperationsClient();
    operationsStore.getState().recordImportedMaterial(
      toImportedMaterial(entry, {
        category: 'video',
        origin: 'group-library',
        importedAt: '2026-08-25T10:00:00.000Z',
      }),
    );
    dispose();
    dispose = () => undefined;

    operationsStore.setState({ materials: { imported: {} } });
    dispose = initializeOperationsClient();

    expect(operationsStore.getState().materials.imported[entry.materialId]?.category).toBe('video');
  });

  it('drops a stored record it cannot validate and keeps the rest', () => {
    const state = operationsStore.getState();
    const { snapshots: _snapshots, ...production } = state.production;
    localStorage.setItem(
      persistedStateKey,
      JSON.stringify({
        version: 5,
        ui: state.ui,
        production,
        personalization: state.personalization,
        materials: {
          imported: {
            // A size that is not a decimal string: `formatBytes` would have
            // printed `NaN` and `toMaterialEntry` would have thrown at the seam.
            'bad-size': { ...validRecord('bad-size'), byteSize: '12.5' },
            // A record whose body names a different material than its key.
            mismatched: { ...validRecord('somebody-else') },
            [entry.materialId]: validRecord(entry.materialId),
          },
        },
      }),
    );

    dispose = initializeOperationsClient();

    expect(Object.keys(operationsStore.getState().materials.imported)).toEqual([entry.materialId]);
  });

  it('ignores a blob whose imported record is not a record at all', () => {
    const state = operationsStore.getState();
    const { snapshots: _snapshots, ...production } = state.production;
    localStorage.setItem(
      persistedStateKey,
      JSON.stringify({
        version: 5,
        ui: state.ui,
        production,
        personalization: state.personalization,
        materials: { imported: 'not-a-record' },
      }),
    );

    dispose = initializeOperationsClient();

    expect(operationsStore.getState().materials.imported).toEqual({});
  });
});

function validRecord(materialId: string) {
  return {
    materialId,
    displayName: 'camera-loop.mp4',
    mimeType: 'video/mp4',
    byteSize: '5368709120',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
    category: 'video',
    origin: 'group-library',
    importedAt: '2026-08-25T10:00:00.000Z',
  };
}
