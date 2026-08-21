import { describe, expect, it } from 'vitest';

import {
  InvalidSettingValueError,
  UnknownSettingError,
  applyDraftPatch,
  createFactorySnapshot,
  createSettingsDraft,
  createSettingsDraftCheckpoint,
  exportDraft,
  getSettingDefinition,
  getSettingsDefinitionsForCategory,
  importDraft,
  publishDraft,
  resetDraftAll,
  resetDraftCategory,
  restoreSettingsDraft,
} from './index.js';

const event = (id: string) => ({ id, at: '2026-08-15T12:00:00.000Z' });

describe('safe settings draft schema', () => {
  it('publishes render metadata derived from the same validator as the mutation contract', () => {
    expect(getSettingDefinition('themes.id')).toMatchObject({
      category: 'themes',
      editor: {
        kind: 'enum',
        options: expect.arrayContaining(['terminal-red', 'cold-cyan']),
      },
    });
    expect(getSettingDefinition('typography.scale')?.editor).toEqual({
      kind: 'number',
      minimum: 0.85,
      maximum: 1.25,
      step: 0.01,
    });
    expect(getSettingsDefinitionsForCategory('themes').map((definition) => definition.id)).toEqual([
      'themes.id',
    ]);
  });

  it('accepts only declared typed settings and retains a deterministic history', () => {
    const draft = createSettingsDraft(createFactorySnapshot());
    const updated = applyDraftPatch(
      draft,
      [
        { id: 'themes.id', value: 'cold-cyan' },
        { id: 'typography.scale', value: 1.15 },
      ],
      event('patch-01'),
    );

    expect(updated.values['themes.id']).toBe('cold-cyan');
    expect(updated.changedIds).toEqual(['themes.id', 'typography.scale']);
    expect(updated.history).toEqual([
      {
        ...event('patch-01'),
        operation: 'patch',
        changedIds: ['themes.id', 'typography.scale'],
      },
    ]);
    expect(() =>
      applyDraftPatch(updated, [{ id: 'unknown.setting', value: true }], event('bad')),
    ).toThrow(UnknownSettingError);
    expect(() =>
      applyDraftPatch(updated, [{ id: 'typography.scale', value: 3 }], event('bad')),
    ).toThrow(InvalidSettingValueError);
  });

  it('resets one category without modifying unrelated draft settings, then resets all', () => {
    const updated = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [
        { id: 'themes.id', value: 'terminal-green' },
        { id: 'layout.density', value: 'mainframe' },
      ],
      event('patch-01'),
    );
    const categoryReset = resetDraftCategory(updated, 'themes', event('reset-theme'));
    const allReset = resetDraftAll(categoryReset, event('reset-all'));

    expect(categoryReset.values['themes.id']).toBe('terminal-red');
    expect(categoryReset.values['layout.density']).toBe('mainframe');
    expect(allReset.values['layout.density']).toBe('dense');
    expect(allReset.history.map((entry) => entry.operation)).toEqual([
      'patch',
      'reset-category',
      'reset-all',
    ]);
  });

  it('exports only schema-valid settings and restores an import as a new draft event', () => {
    const original = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'cameras.gridDensity', value: '3x3' }],
      event('patch-01'),
    );
    const restored = importDraft(
      createSettingsDraft(createFactorySnapshot()),
      exportDraft(original),
      event('import-01'),
    );

    expect(restored.values['cameras.gridDensity']).toBe('3x3');
    expect(restored.history[0]?.operation).toBe('import');
    expect(publishDraft(restored)).toMatchObject({ revision: 1, values: restored.values });
    expect(() => importDraft(restored, '{"revision":0,"values":{}}', event('broken'))).toThrow(
      InvalidSettingValueError,
    );
  });

  it('restores only a schema-valid immutable checkpoint into a new draft history event', () => {
    const draft = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'themes.id', value: 'terminal-green' }],
      event('patch-01'),
    );
    const checkpoint = createSettingsDraftCheckpoint(draft);
    const changed = applyDraftPatch(
      draft,
      [{ id: 'themes.id', value: 'cold-cyan' }],
      event('patch-02'),
    );
    const restored = restoreSettingsDraft(changed, checkpoint, event('restore-01'));

    expect(restored.values['themes.id']).toBe('terminal-green');
    expect(restored.changedIds).toEqual(['themes.id']);
    expect(restored.history.at(-1)).toMatchObject({
      operation: 'restore',
      changedIds: ['themes.id'],
    });
  });
});

describe('background source settings', () => {
  const patch = (id: string, value: unknown) =>
    applyDraftPatch(createSettingsDraft(createFactorySnapshot()), [{ id, value }], event('bg-1'));

  it('declares a picker over the material catalogue, not a free-text field', () => {
    // The editor catalogue is the whole of what the safe editor may render. A
    // source that arrived as typed text would be a new trust boundary; naming
    // the accepted media instead keeps the operator choosing from material the
    // application already holds.
    expect(getSettingDefinition('backgrounds.imageSource')?.editor).toEqual({
      kind: 'material',
      accept: ['image/'],
    });
    expect(getSettingDefinition('backgrounds.videoSource')?.editor).toEqual({
      kind: 'material',
      accept: ['video/'],
    });
  });

  it('belongs to the backgrounds category, so its reset button is the one for backgrounds', () => {
    // R5 applies to it for free precisely because it is a declared setting and
    // not a registry off to one side.
    expect(
      getSettingsDefinitionsForCategory('backgrounds').map((definition) => definition.id),
    ).toEqual(['backgrounds.kind', 'backgrounds.imageSource', 'backgrounds.videoSource']);
  });

  it('starts unset, and the empty string is how an operator clears it', () => {
    expect(getSettingDefinition('backgrounds.imageSource')?.defaultValue).toBe('');
    expect(patch('backgrounds.imageSource', '').values['backgrounds.imageSource']).toBe('');
  });

  it('accepts a material identifier', () => {
    const id = '018f0f1a-8000-7000-8000-000000000000';
    expect(patch('backgrounds.imageSource', id).values['backgrounds.imageSource']).toBe(id);
  });

  it.each([
    ['a filesystem path', '/Материалы/Фон.jpg'],
    ['a URL, which is the thing this must never become', 'https://example.test/a.jpg'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['a CSS fragment', 'url(evil.png)'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['a number', 3],
  ])('rejects %s', (_reason, value) => {
    expect(() => patch('backgrounds.imageSource', value)).toThrow(InvalidSettingValueError);
  });
});
