import { describe, expect, it } from 'vitest';

import {
  InvalidSettingValueError,
  UnknownSettingError,
  applyDraftPatch,
  createFactorySnapshot,
  createSettingsDraft,
  createSettingsDraftCheckpoint,
  curveInterpolations,
  exportDraft,
  getSettingDefinition,
  getSettingsDefinitionsForCategory,
  importDraft,
  maximumCurvePoints,
  publishDraft,
  resetDraftAll,
  resetDraftCategory,
  restoreSettingsDraft,
  simulationChannels,
  titlebarElements,
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
    // The accessor returns a category's definitions in declaration order.
    // Asserted as a set rather than a list of one, so filling a category does
    // not break a test about how the accessor works.
    expect(
      getSettingsDefinitionsForCategory('themes').map((definition) => definition.id),
    ).toContain('themes.id');
    expect(
      getSettingsDefinitionsForCategory('themes').every(
        (definition) => definition.category === 'themes',
      ),
    ).toBe(true);
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

    // A value that is present and wrong is refused by name. This is the trust
    // boundary, and it does not move.
    expect(() =>
      importDraft(
        restored,
        '{"revision":0,"values":{"cameras.gridDensity":"9x9"}}',
        event('broken'),
      ),
    ).toThrow(InvalidSettingValueError);
  });

  it('imports a file written before a setting existed, filling the gap from the schema', () => {
    /*
     * Every definition used to be required to be present, so adding one made
     * every previously exported file unimportable. R6 adds definitions by the
     * dozen; that would have turned a rare failure into the usual one.
     *
     * The file below is the shape of an old export: a revision, and only the
     * settings that existed when it was written.
     */
    const older = JSON.stringify({ revision: 0, values: { 'cameras.gridDensity': '2x2' } });
    const restored = importDraft(
      createSettingsDraft(createFactorySnapshot()),
      older,
      event('import-old'),
    );

    expect(restored.values['cameras.gridDensity']).toBe('2x2');
    // The settings it predates arrive at exactly what a fresh draft holds --
    // read from the schema rather than restated here, because a literal would
    // be a second copy of the default.
    const fresh = createSettingsDraft(createFactorySnapshot());
    expect(restored.values['layout.density']).toBe(fresh.values['layout.density']);
    expect(restored.values['themes.id']).toBe(fresh.values['themes.id']);
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
    // The three source settings, plus the wash the category has grown since.
    // Asserted as containment rather than as the exact roster: this test is
    // about a source setting belonging to its category, and a list that has to
    // be edited every time the category gains a member tests the edit, not the
    // membership.
    expect(
      getSettingsDefinitionsForCategory('backgrounds').map((definition) => definition.id),
    ).toEqual(
      expect.arrayContaining([
        'backgrounds.kind',
        'backgrounds.imageSource',
        'backgrounds.videoSource',
      ]),
    );
    expect(
      getSettingsDefinitionsForCategory('backgrounds').every((definition) =>
        definition.id.startsWith('backgrounds.'),
      ),
    ).toBe(true);
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

describe('simulation curve settings', () => {
  const patch = (id: string, value: unknown) =>
    applyDraftPatch(createSettingsDraft(createFactorySnapshot()), [{ id, value }], event('sim-1'));

  const pointsFor = (channel: string, count: number): readonly string[] =>
    Array.from(
      { length: count },
      (_unused, index) => `${channel}=${(index / 1000).toFixed(3)},20,0,0`,
    );

  it('declares a curve editor carrying every bound the control needs, and no free-text mode', () => {
    // The editor catalogue is the whole of what the safe editor may render, and
    // a curve joins it as a declaration rather than as typed coordinates: the
    // control reads its domains from here, so nothing downstream carries a
    // constant of its own.
    expect(getSettingDefinition('simulation.valueCurve')?.editor).toEqual({
      kind: 'curve',
      channels: simulationChannels,
      timeDomain: [0, 1],
      valueDomain: [0, 100],
      restingValue: 50,
      unit: '%',
      maximumPoints: maximumCurvePoints,
    });
    expect(getSettingDefinition('simulation.criticalityCurve')?.editor).toEqual({
      kind: 'curve',
      channels: simulationChannels,
      timeDomain: [0, 1],
      valueDomain: [0, 1],
      restingValue: 0,
      unit: '',
      maximumPoints: maximumCurvePoints,
    });
  });

  it('starts with no curve at all, which is how a channel says nothing is scripted', () => {
    expect(getSettingDefinition('simulation.valueCurve')?.defaultValue).toEqual([]);
    expect(getSettingDefinition('simulation.criticalityCurve')?.defaultValue).toEqual([]);
  });

  it('accepts a canonical curve over several channels', () => {
    const entries = [
      'cpu=0,20,0,0',
      'cpu=0.5,88.25,0,0',
      'cpu=1,20,0,0',
      'ram=0,40,0,0',
      'ram=1,40,-12.5,3',
    ];

    expect(patch('simulation.valueCurve', entries).values['simulation.valueCurve']).toEqual(
      entries,
    );
  });

  it('accepts a single-point curve, which the evaluator holds everywhere', () => {
    expect(patch('simulation.valueCurve', ['gpu=0.25,10,0,0']).values['simulation.valueCurve']) //
      .toEqual(['gpu=0.25,10,0,0']);
  });

  it.each([
    ['a point with no channel', ['0,20,0,0']],
    ['a channel the schema does not declare', ['disk=0,20,0,0']],
    ['a channel in the wrong case', ['CPU=0,20,0,0']],
    ['three coordinates instead of four', ['cpu=0,20,0']],
    ['five coordinates', ['cpu=0,20,0,0,0']],
    ['a coordinate that is not a number', ['cpu=0,high,0,0']],
    ['a coordinate in exponent form', ['cpu=0,1e2,0,0']],
    ['a leading zero, which is not the canonical spelling', ['cpu=0,007,0,0']],
    ['more decimals than an entry may carry', ['cpu=0.1234567,20,0,0']],
    ['a time past the end of the period', ['cpu=1.5,20,0,0']],
    ['a negative time', ['cpu=-0.5,20,0,0']],
    ['a value above the declared domain', ['cpu=0,120,0,0']],
    ['a value below the declared domain', ['cpu=0,-1,0,0']],
    ['two points at one time', ['cpu=0.5,20,0,0', 'cpu=0.5,30,0,0']],
    ['points in descending time', ['cpu=0.5,20,0,0', 'cpu=0.25,30,0,0']],
    ['channels out of order', ['ram=0,20,0,0', 'cpu=0,20,0,0']],
    ['one channel interrupted and resumed', ['cpu=0,20,0,0', 'ram=0,20,0,0', 'cpu=1,20,0,0']],
    ['a bare string rather than a list', 'cpu=0,20,0,0'],
    ['a list holding something that is not a string', [42]],
    ['a separator that is not a comma', ['cpu=0;20;0;0']],
    ['whitespace around an entry', [' cpu=0,20,0,0 ']],
  ])('refuses %s', (_reason, value) => {
    expect(() => patch('simulation.valueCurve', value)).toThrow(InvalidSettingValueError);
  });

  it('holds each curve to its own declared value domain', () => {
    // The two curves share one entry form and differ only in the domain they
    // declare, so the same coordinate is legal on one and refused on the other.
    expect(
      patch('simulation.valueCurve', ['cpu=0,50,0,0']).values['simulation.valueCurve'],
    ).toEqual(['cpu=0,50,0,0']);
    expect(() => patch('simulation.criticalityCurve', ['cpu=0,50,0,0'])).toThrow(
      InvalidSettingValueError,
    );
  });

  it('accepts exactly the wire’s point ceiling, and refuses one more', () => {
    expect(
      patch('simulation.valueCurve', pointsFor('cpu', maximumCurvePoints)).values[
        'simulation.valueCurve'
      ],
    ).toHaveLength(maximumCurvePoints);
    expect(() => patch('simulation.valueCurve', pointsFor('cpu', maximumCurvePoints + 1))).toThrow(
      InvalidSettingValueError,
    );
  });

  it('counts the ceiling per channel rather than over the whole list', () => {
    // The ceiling the control plane enforces is a bound on one curve. Two full
    // channels are two curves, and refusing them here would refuse a profile
    // the server accepts.
    const both = [...pointsFor('cpu', maximumCurvePoints), ...pointsFor('ram', maximumCurvePoints)];

    expect(patch('simulation.valueCurve', both).values['simulation.valueCurve']).toHaveLength(
      maximumCurvePoints * 2,
    );
  });
});

describe('simulation timing and variation settings', () => {
  const patch = (id: string, value: unknown) =>
    applyDraftPatch(createSettingsDraft(createFactorySnapshot()), [{ id, value }], event('sim-2'));

  it('mirrors the bounds TelemetryService validates on the wire', () => {
    expect(getSettingDefinition('simulation.periodSeconds')?.editor).toEqual({
      kind: 'number',
      minimum: 1,
      maximum: 86_400,
      step: 1,
    });
    expect(getSettingDefinition('simulation.updateIntervalMs')?.editor).toEqual({
      kind: 'number',
      minimum: 1,
      maximum: 3_600_000,
      step: 1,
    });
    expect(getSettingDefinition('simulation.timeScale')?.editor).toEqual({
      kind: 'number',
      minimum: 0,
      maximum: 1_000,
      step: 0.1,
    });
  });

  it.each([
    ['simulation.periodSeconds', 86_401],
    ['simulation.periodSeconds', 0],
    ['simulation.updateIntervalMs', 3_600_001],
    ['simulation.updateIntervalMs', 0],
    ['simulation.timeScale', 1_000.5],
    ['simulation.timeScale', -0.5],
    ['simulation.noise', 1.5],
    ['simulation.smoothing', -0.1],
    ['simulation.seed', 4_294_967_296],
  ])('refuses %s outside its bound: %s', (id, value) => {
    expect(() => patch(id, value)).toThrow(InvalidSettingValueError);
  });

  it('refuses a fractional period, because the wire field is a uint32', () => {
    // `numberWithin` would have accepted 1.5 seconds and handed the control
    // plane something `period_seconds` cannot carry.
    expect(() => patch('simulation.periodSeconds', 1.5)).toThrow(InvalidSettingValueError);
    expect(() => patch('simulation.updateIntervalMs', 250.5)).toThrow(InvalidSettingValueError);
    expect(() => patch('simulation.seed', 1.5)).toThrow(InvalidSettingValueError);
    // A time scale is not a wire integer, and half speed has to stay expressible.
    expect(patch('simulation.timeScale', 0.5).values['simulation.timeScale']).toBe(0.5);
  });

  it('offers exactly the interpolations the domain evaluator implements', () => {
    expect(getSettingDefinition('simulation.interpolation')?.editor).toEqual({
      kind: 'enum',
      options: curveInterpolations,
    });
    expect(() => patch('simulation.interpolation', 'catmull-rom')).toThrow(
      InvalidSettingValueError,
    );
  });

  it('scopes the whole simulation to the group, as simulation.preset already was', () => {
    // A curve one operator drags and another never sees is two shoots, not one.
    // Asserted over the category rather than over a roster that would have to
    // be edited every time the category grows.
    expect(
      getSettingsDefinitionsForCategory('simulation').every(
        (definition) => definition.scope === 'group',
      ),
    ).toBe(true);
    expect(getSettingsDefinitionsForCategory('simulation').length).toBeGreaterThan(1);
  });
});

describe('titlebar settings', () => {
  const patch = (id: string, value: unknown) =>
    applyDraftPatch(createSettingsDraft(createFactorySnapshot()), [{ id, value }], event('bar-1'));

  it('opens with every element the bar can draw, in the order it draws them', () => {
    // The default is the whole roster rather than an empty list: `tiles.order`
    // can start empty because a screen already knows its own tiles, and the
    // title bar's arrangement is the setting itself.
    expect(getSettingDefinition('titlebar.elements')?.defaultValue).toEqual(titlebarElements);
    expect(getSettingDefinition('titlebar.elements')?.editor).toEqual({
      kind: 'string-list',
      delimiter: ',',
    });
  });

  it('accepts an arrangement over the roster, including dropping a control entirely', () => {
    expect(patch('titlebar.elements', ['close', 'title']).values['titlebar.elements']).toEqual([
      'close',
      'title',
    ]);
    expect(patch('titlebar.elements', []).values['titlebar.elements']).toEqual([]);
  });

  it('refuses an element the bar has no way to draw', () => {
    expect(() => patch('titlebar.elements', ['pin'])).toThrow(InvalidSettingValueError);
    expect(() => patch('titlebar.elements', [17])).toThrow(InvalidSettingValueError);
  });

  it('refuses the same element twice, because the bar keys its elements by name', () => {
    expect(() => patch('titlebar.elements', ['close', 'close'])).toThrow(InvalidSettingValueError);
  });

  it('offers only the four arrangements, the four readings and the three drag regions', () => {
    expect(getSettingDefinition('titlebar.alignment')?.editor).toEqual({
      kind: 'enum',
      options: ['left', 'center', 'split', 'right'],
    });
    expect(getSettingDefinition('titlebar.information')?.editor).toEqual({
      kind: 'enum',
      options: ['route', 'clock', 'operation', 'connection', 'none'],
    });
    expect(getSettingDefinition('titlebar.dragRegion')?.editor).toEqual({
      kind: 'enum',
      options: ['full', 'title', 'none'],
    });
    // A reading the shell cannot supply would be an operator choosing a slot
    // that stays empty.
    expect(() => patch('titlebar.information', 'weather')).toThrow(InvalidSettingValueError);
  });

  it('keeps the whole bar a per-device choice, as titlebar.alignment already was', () => {
    // The bar belongs to the window in front of one operator; a group that
    // pushed its own arrangement would move the close button on a machine
    // nobody is standing at.
    expect(
      getSettingsDefinitionsForCategory('titlebar').every(
        (definition) => definition.scope === 'device',
      ),
    ).toBe(true);
    expect(getSettingsDefinitionsForCategory('titlebar')).toHaveLength(4);
  });
});
