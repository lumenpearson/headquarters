import { describe, expect, it } from 'vitest';

import { operationsSeed } from '@/data/operationsSeed';

import {
  ContentPatchError,
  contentElementId,
  contentFieldDefinitions,
  contentKey,
  fromLocalDateTimeInput,
  getContentFieldDefinition,
  parseContentElementId,
  parseContentKey,
  patchContentOverrides,
  projectContentOverrides,
  readContentValue,
  sanitizeContentOverrides,
  seedContentValue,
  toLocalDateTimeInput,
  type ContentWorld,
} from './contentFields';

function byId<Entity extends { readonly id: string }>(
  entities: readonly Entity[],
): Readonly<Record<string, Entity>> {
  return Object.fromEntries(entities.map((entity) => [entity.id, entity]));
}

function seedWorld(): ContentWorld {
  return {
    operation: operationsSeed.operation,
    cases: byId(operationsSeed.cases),
    people: byId(operationsSeed.people),
    reports: byId(operationsSeed.reports),
    events: operationsSeed.events,
  };
}

/** One seeded entity per prefix a field id can carry. */
const sampleEntity: Readonly<Record<string, string>> = {
  operation: 'OP-GS-042',
  case: 'CASE-01',
  person: 'P-01',
  event: 'EV-1001',
  report: 'REP-01',
};

function reason(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (failure) {
    return failure instanceof ContentPatchError ? failure.reason : 'not a ContentPatchError';
  }
}

function localParts(instant: string): readonly number[] {
  const date = new Date(instant);
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
}

describe('content field registry', () => {
  it('reads a seed value for every definition, so each editor edits something real', () => {
    for (const definition of contentFieldDefinitions) {
      const entityId = sampleEntity[definition.id.split('.')[0] ?? ''];
      expect(entityId, definition.id).toBeDefined();
      const value = seedContentValue(definition.id, entityId ?? '');
      expect(value, definition.id).toBeDefined();
      // A validator that refuses the value its own field already holds would
      // make the first edit impossible to undo through a patch.
      expect(definition.validate(value), `${definition.id} accepts its seed value`).toBe(true);
    }
  });

  it('covers every kind the union declares with at least one rendered field', () => {
    const kinds = new Set(contentFieldDefinitions.map((definition) => definition.editor.kind));
    expect([...kinds].sort()).toEqual(['date', 'datetime', 'text', 'time']);
  });

  it('refuses a patch for a field it does not declare', () => {
    expect(
      reason(() =>
        patchContentOverrides({}, [{ id: 'case.priority', entityId: 'CASE-01', value: '3' }]),
      ),
    ).toBe('unknown-field');
    expect(getContentFieldDefinition('case.priority')).toBeUndefined();
  });

  it('refuses a patch for an entity the seed never held', () => {
    // A simulation-generated event exists in the running world but not in the
    // seed, so nothing could put its value back or re-apply it on launch.
    expect(
      reason(() =>
        patchContentOverrides({}, [{ id: 'event.title', entityId: 'EV-LIVE-3', value: 'X' }]),
      ),
    ).toBe('unknown-entity');
  });

  it('refuses a date that is not a calendar day', () => {
    for (const value of ['2026-02-30', '12.09.2026', '2026-9-1', 20260912, '', null]) {
      expect(
        reason(() =>
          patchContentOverrides({}, [{ id: 'case.createdAt', entityId: 'CASE-01', value }]),
        ),
        String(value),
      ).toBe('invalid-value');
    }
  });

  it('refuses a time outside the clock', () => {
    for (const value of ['24:00', '07:60', '7:42', '07:42:60', '0742']) {
      expect(
        reason(() => patchContentOverrides({}, [{ id: 'event.time', entityId: 'EV-1001', value }])),
        value,
      ).toBe('invalid-value');
    }
    expect(
      reason(() =>
        patchContentOverrides({}, [{ id: 'event.time', entityId: 'EV-1001', value: '23:59' }]),
      ),
    ).toBeUndefined();
  });

  it('refuses an instant that is not ISO 8601', () => {
    for (const value of ['2026-09-12 07:42', 'yesterday', '2026-09-12T07:42']) {
      expect(
        reason(() =>
          patchContentOverrides({}, [{ id: 'report.createdAt', entityId: 'REP-01', value }]),
        ),
        value,
      ).toBe('invalid-value');
    }
  });

  it('refuses empty, overlong and control-character text, and a line break in a title', () => {
    for (const value of ['   ', 'x'.repeat(161), 'AB', 'A\nB']) {
      expect(
        reason(() => patchContentOverrides({}, [{ id: 'case.title', entityId: 'CASE-01', value }])),
        JSON.stringify(value),
      ).toBe('invalid-value');
    }
    // A paragraph may break lines; it still may not carry a bell.
    expect(
      reason(() =>
        patchContentOverrides({}, [
          { id: 'operation.summary', entityId: 'OP-GS-042', value: 'A\nB' },
        ]),
      ),
    ).toBeUndefined();
    expect(
      reason(() =>
        patchContentOverrides({}, [
          { id: 'operation.summary', entityId: 'OP-GS-042', value: 'AB' },
        ]),
      ),
    ).toBe('invalid-value');
  });

  it('drops an override that equals the seed instead of storing a non-change', () => {
    const seed = seedContentValue('person.birthDate', 'P-01');
    const changed = patchContentOverrides({}, [
      { id: 'person.birthDate', entityId: 'P-01', value: '1980-01-15' },
    ]);
    expect(changed.overrides).toEqual({ 'person.birthDate@P-01': '1980-01-15' });

    const back = patchContentOverrides(changed.overrides, [
      { id: 'person.birthDate', entityId: 'P-01', value: seed },
    ]);
    expect(back.overrides).toEqual({});
    // Still a change the ledger has to name, so it is listed.
    expect(back.changedIds).toEqual(['person.birthDate@P-01']);
  });

  it('projects a date and a time onto one instant, and reverts one without the other', () => {
    const world = seedWorld();
    const seedEvent = world.events.find((event) => event.id === 'EV-1001');
    expect(seedEvent).toBeDefined();

    const { overrides } = patchContentOverrides({}, [
      { id: 'event.date', entityId: 'EV-1001', value: '2026-10-03' },
      { id: 'event.time', entityId: 'EV-1001', value: '18:05:09' },
    ]);
    const patched = { ...world, ...projectContentOverrides(world, {}, overrides) };
    const stamp = patched.events.find((event) => event.id === 'EV-1001')?.timestamp ?? '';
    expect(localParts(stamp)).toEqual([2026, 10, 3, 18, 5, 9]);
    // Other events are the same objects: the write touched one entry.
    expect(patched.events[1]).toBe(world.events[1]);

    const reverted = patchContentOverrides(overrides, [
      { id: 'event.date', entityId: 'EV-1001', value: seedContentValue('event.date', 'EV-1001') },
    ]);
    expect(Object.keys(reverted.overrides)).toEqual(['event.time@EV-1001']);
    const back = { ...patched, ...projectContentOverrides(patched, overrides, reverted.overrides) };
    const backStamp = back.events.find((event) => event.id === 'EV-1001')?.timestamp ?? '';
    const [year, month, day] = localParts(seedEvent?.timestamp ?? '');
    expect(localParts(backStamp)).toEqual([year, month, day, 18, 5, 9]);
    expect(readContentValue(back, 'event.time', 'EV-1001')).toBe('18:05:09');
  });

  it('keeps a stored override only where the field, the entity and the value hold up', () => {
    expect(sanitizeContentOverrides(undefined)).toEqual({});
    expect(sanitizeContentOverrides('nonsense')).toEqual({});
    expect(
      sanitizeContentOverrides({
        'case.title@CASE-01': 'ДЕЛО / ПРОВЕРЕНО',
        'case.createdAt@CASE-01': '2026-02-30',
        'case.title@CASE-99': 'НЕТ ТАКОГО ДЕЛА',
        'case.rank@CASE-01': 'x',
        'person.birthDate@P-01': seedContentValue('person.birthDate', 'P-01'),
        'report.title@REP-01': 42,
        nonsense: 'x',
      }),
    ).toEqual({ 'case.title@CASE-01': 'ДЕЛО / ПРОВЕРЕНО' });
  });

  it('round-trips keys and element ids, and tells a tile id from a content one', () => {
    expect(parseContentKey(contentKey('case.title', 'CASE-01'))).toEqual({
      id: 'case.title',
      entityId: 'CASE-01',
    });
    expect(parseContentKey('case.title')).toBeUndefined();
    expect(parseContentKey('@CASE-01')).toBeUndefined();
    expect(parseContentKey('case.title@')).toBeUndefined();

    const elementId = contentElementId('event.time', 'EV-1001');
    expect(parseContentElementId(elementId)).toEqual({ id: 'event.time', entityId: 'EV-1001' });
    expect(parseContentElementId('registry')).toBeUndefined();
    expect(parseContentElementId('content:')).toBeUndefined();
  });

  it('converts a datetime-local value as local time, both ways', () => {
    const instant = fromLocalDateTimeInput('2026-09-12T07:42:15');
    expect(instant).toBeDefined();
    expect(toLocalDateTimeInput(instant ?? '')).toBe('2026-09-12T07:42:15');
    expect(fromLocalDateTimeInput('')).toBeUndefined();
    expect(fromLocalDateTimeInput('not a date')).toBeUndefined();
    expect(toLocalDateTimeInput('not a date')).toBe('');
  });
});
