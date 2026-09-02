import { describe, expect, it } from 'vitest';

import {
  addMaterialAnnotation,
  annotationsFor,
  materialAnnotationsStorageKey,
  normalizeMaterialAnnotations,
  readMaterialAnnotations,
  removeMaterialAnnotation,
  writeMaterialAnnotations,
} from './materialAnnotations';

class MemoryStorage {
  #data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#data.set(key, value);
  }
}

describe('material annotations', () => {
  it('adds a note at the given timestamp, keeping notes sorted by time', () => {
    let annotations = addMaterialAnnotation(
      {},
      'material-1',
      42,
      'second note',
      () => '2026-08-29T00:00:01.000Z',
      () => 'id-2',
    );
    annotations = addMaterialAnnotation(
      annotations,
      'material-1',
      10,
      'first note',
      () => '2026-08-29T00:00:00.000Z',
      () => 'id-1',
    );

    expect(annotationsFor(annotations, 'material-1').map((entry) => entry.text)).toEqual([
      'first note',
      'second note',
    ]);
  });

  it('drops a note with only whitespace', () => {
    const annotations = addMaterialAnnotation({}, 'material-1', 0, '   ');
    expect(annotationsFor(annotations, 'material-1')).toEqual([]);
  });

  it('clamps a negative timestamp to zero', () => {
    const annotations = addMaterialAnnotation({}, 'material-1', -5, 'note');
    expect(annotationsFor(annotations, 'material-1')[0]?.timestampSeconds).toBe(0);
  });

  it('removes one note without disturbing another material', () => {
    let annotations = addMaterialAnnotation(
      {},
      'material-1',
      1,
      'keep me',
      () => 'now',
      () => 'id-keep',
    );
    annotations = addMaterialAnnotation(
      annotations,
      'material-1',
      2,
      'drop me',
      () => 'now',
      () => 'id-drop',
    );
    annotations = addMaterialAnnotation(
      annotations,
      'material-2',
      1,
      'untouched',
      () => 'now',
      () => 'id-other',
    );

    const next = removeMaterialAnnotation(annotations, 'material-1', 'id-drop');

    expect(annotationsFor(next, 'material-1').map((entry) => entry.id)).toEqual(['id-keep']);
    expect(annotationsFor(next, 'material-2').map((entry) => entry.id)).toEqual(['id-other']);
  });

  it('drops the material key entirely once its last note is removed', () => {
    let annotations = addMaterialAnnotation(
      {},
      'material-1',
      1,
      'only note',
      () => 'now',
      () => 'id-1',
    );
    annotations = removeMaterialAnnotation(annotations, 'material-1', 'id-1');

    expect(Object.hasOwn(annotations, 'material-1')).toBe(false);
  });

  it('round-trips through storage', () => {
    const storage = new MemoryStorage();
    const annotations = addMaterialAnnotation(
      {},
      'material-1',
      3,
      'persisted note',
      () => 'now',
      () => 'id-1',
    );

    writeMaterialAnnotations(storage, annotations);

    expect(storage.getItem(materialAnnotationsStorageKey)).not.toBeNull();
    expect(readMaterialAnnotations(storage)).toEqual(annotations);
  });

  it('discards a stored entry naming a different material than its own key', () => {
    const tampered = {
      'material-1': [
        {
          id: 'id-1',
          materialId: 'material-2',
          timestampSeconds: 1,
          text: 'mismatched',
          createdAt: 'now',
        },
      ],
    };

    expect(normalizeMaterialAnnotations(tampered)).toEqual({});
  });

  it('recovers to empty rather than throwing on unparsable storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(materialAnnotationsStorageKey, '{not json');

    expect(readMaterialAnnotations(storage)).toEqual({});
  });
});
