import { describe, expect, it } from 'vitest';

import type { MaterialEntry } from '../materials/BridgeMaterialClient';
import {
  cameraMaterialAssignmentsStorageKey,
  demoCameraMaterialOption,
  isAssignableCameraMaterial,
  readCameraMaterialAssignments,
  setCameraMaterialAssignment,
  writeCameraMaterialAssignments,
} from './cameraMaterialAssignments';

const materialId = '018f0f1a-8000-7000-8000-000000000000';

describe('camera material assignments', () => {
  it('persists opaque material ids and removes an assignment when demo is selected', () => {
    const storage = createStorage();
    const assigned = setCameraMaterialAssignment({}, 'K-17', materialId);
    writeCameraMaterialAssignments(storage, assigned);

    expect(readCameraMaterialAssignments(storage)).toEqual({ 'K-17': materialId });
    expect(
      setCameraMaterialAssignment(
        readCameraMaterialAssignments(storage),
        'K-17',
        demoCameraMaterialOption,
      ),
    ).toEqual({});
  });

  it('rejects malformed persisted values instead of retaining paths or Blob URLs', () => {
    const storage = createStorage(
      JSON.stringify({
        'K-17': materialId,
        '../outside': materialId,
        'CAM-02': 'blob:https://hq.invalid/runtime-source',
        'CAM-03': 'C:\\materials\\video.webm',
      }),
    );

    const sanitized = readCameraMaterialAssignments(storage);
    expect(sanitized).toEqual({ 'K-17': materialId });
    writeCameraMaterialAssignments(storage, sanitized);
    expect(storage.getItem(cameraMaterialAssignmentsStorageKey)).not.toContain('..');
  });

  it('allows positive local video materials as bounded or range-streamed sources', () => {
    expect(isAssignableCameraMaterial(entry({ mimeType: 'video/webm' }))).toBe(true);
    expect(isAssignableCameraMaterial(entry({ mimeType: 'audio/ogg' }))).toBe(false);
    expect(isAssignableCameraMaterial(entry({ byteSize: 64n * 1024n * 1024n }))).toBe(true);
    expect(isAssignableCameraMaterial(entry({ byteSize: 0n }))).toBe(false);
  });
});

function entry(overrides: Partial<MaterialEntry>): MaterialEntry {
  return {
    materialId,
    displayName: 'camera-loop.webm',
    mimeType: 'video/webm',
    byteSize: 1_024n,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

function createStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: (key: string) => (key === cameraMaterialAssignmentsStorageKey ? value : null),
    setItem: (key: string, next: string) => {
      if (key === cameraMaterialAssignmentsStorageKey) value = next;
    },
  };
}
