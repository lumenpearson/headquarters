import type { CaseFile, Operation, OpsEvent, OpsReport, Person } from '@gremuchaya/domain';

import { operationsSeed } from '@/data/operationsSeed';

/**
 * The second target of the edit-mode patch pipeline (R4).
 *
 * F1 built edit mode over one target: a `SettingDefinition` from
 * `settings-schema`, patched through `applySettingsPatch`. The prompt puts
 * "change the date, the time, the information" in the same sentence as editing
 * everything, and that content -- a case's date, an event's time, the text of
 * a brief -- lives in the production world of `operationsStore`, not in a
 * setting. This registry is the same principle over that world: every editable
 * field is a declared descriptor with its own editor and its own validator, an
 * edit is a patch against a descriptor and never code, and nothing outside
 * this list can be changed from edit mode.
 *
 * An edit is kept as an override keyed by field and entity, and projected onto
 * the world entity every reader already displays. That is what makes a change
 * instant (R17) without a second read path, and what makes it reversible: the
 * seed still holds the value an override replaced, so removing the override is
 * the reset.
 */

export const contentFieldKinds = ['date', 'time', 'datetime', 'text'] as const;

export type ContentFieldKind = (typeof contentFieldKinds)[number];

/**
 * The only controls the content editor renders, as `SettingEditor` is for a
 * setting. There is deliberately no free-form kind: `text` is bounded and
 * plain, and a date is a date.
 */
export type ContentFieldEditor =
  | { readonly kind: 'date' }
  | { readonly kind: 'time' }
  | { readonly kind: 'datetime' }
  | { readonly kind: 'text'; readonly multiline: boolean; readonly maxLength: number };

/** The slices of the production world the registry can reach. */
export interface ContentWorld {
  readonly operation: Operation;
  readonly cases: Readonly<Record<string, CaseFile>>;
  readonly people: Readonly<Record<string, Person>>;
  readonly reports: Readonly<Record<string, OpsReport>>;
  readonly events: readonly OpsEvent[];
}

interface ContentFieldAccess {
  /** The operator-facing value, or undefined when the entity is not in `world`. */
  readonly read: (world: ContentWorld, entityId: string) => string | undefined;
  /** The world slices that change, or undefined when the entity is not in `world`. */
  readonly write: (
    world: ContentWorld,
    entityId: string,
    value: string,
  ) => Partial<ContentWorld> | undefined;
}

export interface ContentFieldDefinition extends ContentFieldAccess {
  readonly id: string;
  /** What the panel calls it; Russian, like the rest of the surface. */
  readonly label: string;
  /** English, for the issue draft, as a `SettingDefinition.description` is. */
  readonly description: string;
  readonly editor: ContentFieldEditor;
  readonly validate: (value: unknown) => value is string;
}

export interface ContentTarget {
  readonly id: string;
  readonly entityId: string;
}

export interface ContentPatch extends ContentTarget {
  readonly value: unknown;
}

/** Field-and-entity key to the value that replaced the seed's. */
export type ContentOverrides = Readonly<Record<string, string>>;

export type ContentPatchRejection = 'unknown-field' | 'unknown-entity' | 'invalid-value';

export class ContentPatchError extends Error {
  constructor(
    readonly reason: ContentPatchRejection,
    readonly key: string,
  ) {
    super(`Content patch rejected (${reason}): ${key}`);
    this.name = 'ContentPatchError';
  }
}

// Validators. Each accepts what its kind's editor can produce and nothing wider.

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timePattern = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A real calendar day, so 2026-02-30 is refused rather than rolled over. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = datePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isWallClockTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = timePattern.exec(value);
  if (match === null) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  return hours < 24 && minutes < 60 && seconds < 60;
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' && instantPattern.test(value) && Number.isFinite(Date.parse(value))
  );
}

function textValidator(editor: Extract<ContentFieldEditor, { kind: 'text' }>) {
  // Control characters have no place in a title; a line break has one in a
  // paragraph and nowhere else.
  const forbidden = editor.multiline
    ? /[\u0000-\u0008\u000B-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  return (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= editor.maxLength &&
    !forbidden.test(value);
}

// Codecs between a stored value and the operator-facing one. The screens print
// an instant in the machine's local time, so a date or a time taken from one is
// local too: the day the operator sees is the day they edit.

interface Codec {
  readonly read: (stored: string) => string | undefined;
  readonly write: (stored: string, value: string) => string | undefined;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function parseInstant(stored: string): Date | undefined {
  const date = new Date(stored);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

const identity: Codec = { read: (stored) => stored, write: (_stored, value) => value };

const localDatePart: Codec = {
  read: (stored) => {
    const date = parseInstant(stored);
    if (date === undefined) return undefined;
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  },
  write: (stored, value) => {
    const date = parseInstant(stored);
    const [year, month, day] = value.split('-').map(Number);
    if (date === undefined || year === undefined || month === undefined || day === undefined) {
      return undefined;
    }
    date.setFullYear(year, month - 1, day);
    return date.toISOString();
  },
};

const localTimePart: Codec = {
  read: (stored) => {
    const date = parseInstant(stored);
    if (date === undefined) return undefined;
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },
  write: (stored, value) => {
    const date = parseInstant(stored);
    const [hours, minutes, seconds] = value.split(':').map(Number);
    if (date === undefined || hours === undefined || minutes === undefined) return undefined;
    date.setHours(hours, minutes, seconds ?? 0, 0);
    return date.toISOString();
  },
};

/** What a `datetime-local` control shows for a stored instant. */
export function toLocalDateTimeInput(instant: string): string {
  const date = localDatePart.read(instant);
  const time = localTimePart.read(instant);
  return date === undefined || time === undefined ? '' : `${date}T${time}`;
}

/** The instant a `datetime-local` control's value names, read as local time. */
export function fromLocalDateTimeInput(value: string): string | undefined {
  if (value === '') return undefined;
  return parseInstant(value)?.toISOString();
}

// Accessors. One per shape the world stores an entity in.

interface KeyedCollections {
  readonly cases: CaseFile;
  readonly people: Person;
  readonly reports: OpsReport;
}

type KeyedCollection = keyof KeyedCollections;

function entitiesOf<Collection extends KeyedCollection>(
  world: ContentWorld,
  collection: Collection,
): Readonly<Record<string, KeyedCollections[Collection]>> {
  // `ContentWorld[Collection]` is exactly this record; the assertion says so
  // once, where a generic index cannot narrow.
  return world[collection] as Readonly<Record<string, KeyedCollections[Collection]>>;
}

function keyedField<Collection extends KeyedCollection>(
  collection: Collection,
  get: (entity: KeyedCollections[Collection]) => string,
  set: (entity: KeyedCollections[Collection], stored: string) => KeyedCollections[Collection],
  codec: Codec,
): ContentFieldAccess {
  return {
    read: (world, entityId) => {
      const entity = entitiesOf(world, collection)[entityId];
      return entity === undefined ? undefined : codec.read(get(entity));
    },
    write: (world, entityId, value) => {
      const entities = entitiesOf(world, collection);
      const entity = entities[entityId];
      if (entity === undefined) return undefined;
      const stored = codec.write(get(entity), value);
      if (stored === undefined) return undefined;
      return {
        [collection]: { ...entities, [entityId]: set(entity, stored) },
      } as Partial<ContentWorld>;
    },
  };
}

function eventField(
  get: (event: OpsEvent) => string,
  set: (event: OpsEvent, stored: string) => OpsEvent,
  codec: Codec,
): ContentFieldAccess {
  return {
    read: (world, entityId) => {
      const event = world.events.find((candidate) => candidate.id === entityId);
      return event === undefined ? undefined : codec.read(get(event));
    },
    write: (world, entityId, value) => {
      const index = world.events.findIndex((candidate) => candidate.id === entityId);
      const event = world.events[index];
      if (event === undefined) return undefined;
      const stored = codec.write(get(event), value);
      if (stored === undefined) return undefined;
      const events = [...world.events];
      events[index] = set(event, stored);
      return { events };
    },
  };
}

function operationField(
  get: (operation: Operation) => string,
  set: (operation: Operation, stored: string) => Operation,
  codec: Codec,
): ContentFieldAccess {
  return {
    read: (world, entityId) =>
      world.operation.id === entityId ? codec.read(get(world.operation)) : undefined,
    write: (world, entityId, value) => {
      if (world.operation.id !== entityId) return undefined;
      const stored = codec.write(get(world.operation), value);
      return stored === undefined ? undefined : { operation: set(world.operation, stored) };
    },
  };
}

function temporal(
  id: string,
  kind: 'date' | 'time' | 'datetime',
  label: string,
  description: string,
  access: ContentFieldAccess,
): ContentFieldDefinition {
  const validate = kind === 'date' ? isCalendarDate : kind === 'time' ? isWallClockTime : isInstant;
  return { id, label, description, editor: { kind }, validate, ...access };
}

function text(
  id: string,
  label: string,
  description: string,
  access: ContentFieldAccess,
  options: { readonly multiline: boolean; readonly maxLength: number },
): ContentFieldDefinition {
  const editor = { kind: 'text', ...options } as const;
  return { id, label, description, editor, validate: textValidator(editor), ...access };
}

/**
 * Every field edit mode can change. Each one is rendered by a screen today; a
 * descriptor for a value nothing displays would be an edit nobody can see.
 */
export const contentFieldDefinitions: readonly ContentFieldDefinition[] = [
  text(
    'operation.title',
    'НАЗВАНИЕ ОПЕРАЦИИ',
    'Operation title in the overview header.',
    operationField(
      (operation) => operation.title,
      (operation, title) => ({ ...operation, title }),
      identity,
    ),
    { multiline: false, maxLength: 120 },
  ),
  text(
    'operation.summary',
    'СВОДКА ОПЕРАЦИИ',
    'Operation brief on the overview screen.',
    operationField(
      (operation) => operation.summary,
      (operation, summary) => ({ ...operation, summary }),
      identity,
    ),
    { multiline: true, maxLength: 1200 },
  ),
  text(
    'case.title',
    'НАЗВАНИЕ ДЕЛА',
    'Case title in the case registry.',
    keyedField(
      'cases',
      (caseFile) => caseFile.title,
      (caseFile, title) => ({ ...caseFile, title }),
      identity,
    ),
    { multiline: false, maxLength: 160 },
  ),
  temporal(
    'case.createdAt',
    'date',
    'ДАТА ДЕЛА',
    'Calendar date the case was opened, as the registry prints it.',
    keyedField(
      'cases',
      (caseFile) => caseFile.createdAt,
      (caseFile, createdAt) => ({ ...caseFile, createdAt }),
      localDatePart,
    ),
  ),
  temporal(
    'person.birthDate',
    'date',
    'ДАТА РОЖДЕНИЯ',
    'Birth date on the dossier card.',
    keyedField(
      'people',
      (person) => person.birthDate,
      (person, birthDate) => ({ ...person, birthDate }),
      identity,
    ),
  ),
  text(
    'event.title',
    'НАЗВАНИЕ СОБЫТИЯ',
    'Event title in the feeds and on the event card.',
    eventField(
      (event) => event.title,
      (event, title) => ({ ...event, title }),
      identity,
    ),
    { multiline: false, maxLength: 160 },
  ),
  text(
    'event.description',
    'ОПИСАНИЕ СОБЫТИЯ',
    'Event description on the event card.',
    eventField(
      (event) => event.description,
      (event, description) => ({ ...event, description }),
      identity,
    ),
    { multiline: true, maxLength: 1200 },
  ),
  temporal(
    'event.date',
    'date',
    'ДАТА СОБЫТИЯ',
    'Calendar date of the event; the time of day is kept.',
    eventField(
      (event) => event.timestamp,
      (event, timestamp) => ({ ...event, timestamp }),
      localDatePart,
    ),
  ),
  temporal(
    'event.time',
    'time',
    'ВРЕМЯ СОБЫТИЯ',
    'Time of day of the event; the calendar date is kept.',
    eventField(
      (event) => event.timestamp,
      (event, timestamp) => ({ ...event, timestamp }),
      localTimePart,
    ),
  ),
  text(
    'report.title',
    'НАЗВАНИЕ ОТЧЁТА',
    'Report title in the report registry.',
    keyedField(
      'reports',
      (report) => report.title,
      (report, title) => ({ ...report, title }),
      identity,
    ),
    { multiline: false, maxLength: 160 },
  ),
  temporal(
    'report.createdAt',
    'datetime',
    'ДАТА И ВРЕМЯ ОТЧЁТА',
    'Instant the report was created, as the registry prints it.',
    keyedField(
      'reports',
      (report) => report.createdAt,
      (report, createdAt) => ({ ...report, createdAt }),
      identity,
    ),
  ),
];

const definitionById = new Map(
  contentFieldDefinitions.map((definition) => [definition.id, definition]),
);

export function getContentFieldDefinition(id: string): ContentFieldDefinition | undefined {
  return definitionById.get(id);
}

function byId<Entity extends { readonly id: string }>(
  entities: readonly Entity[],
): Readonly<Record<string, Entity>> {
  return Object.fromEntries(entities.map((entity) => [entity.id, entity]));
}

/**
 * The world as shipped. What an override replaced is read from here, which is
 * why only a seeded entity can be edited: a value the seed never held could
 * not be put back, and could not be re-applied on the next launch either.
 */
const seedWorld: ContentWorld = {
  operation: operationsSeed.operation,
  cases: byId(operationsSeed.cases),
  people: byId(operationsSeed.people),
  reports: byId(operationsSeed.reports),
  events: operationsSeed.events,
};

// Keys. A field id never contains `@`, and no entity id in the seed does either.

const elementPrefix = 'content:';

export function contentKey(id: string, entityId: string): string {
  return `${id}@${entityId}`;
}

export function parseContentKey(key: string): ContentTarget | undefined {
  const at = key.indexOf('@');
  if (at <= 0 || at === key.length - 1) return undefined;
  return { id: key.slice(0, at), entityId: key.slice(at + 1) };
}

/**
 * What `edit.selectedElementId` holds while a content element is selected.
 * Prefixed so a tile consumer of the same field can tell it is not a tile.
 */
export function contentElementId(id: string, entityId: string): string {
  return `${elementPrefix}${contentKey(id, entityId)}`;
}

export function parseContentElementId(elementId: string): ContentTarget | undefined {
  return elementId.startsWith(elementPrefix)
    ? parseContentKey(elementId.slice(elementPrefix.length))
    : undefined;
}

export function readContentValue(
  world: ContentWorld,
  id: string,
  entityId: string,
): string | undefined {
  return definitionById.get(id)?.read(world, entityId);
}

export function seedContentValue(id: string, entityId: string): string | undefined {
  return definitionById.get(id)?.read(seedWorld, entityId);
}

/**
 * The overrides after `patches`, or a thrown `ContentPatchError` for the first
 * patch that names no field, no seeded entity, or a value the field refuses --
 * the contract `applyDraftPatch` keeps for a setting. A value equal to the
 * seed's removes the override rather than storing a change that is not one.
 */
export function patchContentOverrides(
  current: ContentOverrides,
  patches: readonly ContentPatch[],
): { readonly overrides: ContentOverrides; readonly changedIds: readonly string[] } {
  const overrides = new Map(Object.entries(current));
  const changedIds: string[] = [];
  for (const patch of patches) {
    const key = contentKey(patch.id, patch.entityId);
    const definition = definitionById.get(patch.id);
    if (definition === undefined) throw new ContentPatchError('unknown-field', key);
    const seed = definition.read(seedWorld, patch.entityId);
    if (seed === undefined) throw new ContentPatchError('unknown-entity', key);
    if (!definition.validate(patch.value)) throw new ContentPatchError('invalid-value', key);
    if (patch.value === seed) overrides.delete(key);
    else overrides.set(key, patch.value);
    changedIds.push(key);
  }
  return { overrides: Object.fromEntries(overrides), changedIds: [...new Set(changedIds)] };
}

/**
 * Overrides read back from storage or from another session, kept only where
 * the field, the seeded entity and the value all still hold up. Silent rather
 * than thrown: a stale key from an older build is not the operator's mistake.
 */
export function sanitizeContentOverrides(value: unknown): ContentOverrides {
  if (typeof value !== 'object' || value === null) return {};
  const overrides = new Map<string, string>();
  for (const [key, candidate] of Object.entries(value)) {
    const target = parseContentKey(key);
    const definition = target === undefined ? undefined : definitionById.get(target.id);
    if (target === undefined || definition === undefined) continue;
    const seed = definition.read(seedWorld, target.entityId);
    if (seed === undefined || !definition.validate(candidate) || candidate === seed) continue;
    overrides.set(key, candidate);
  }
  return Object.fromEntries(overrides);
}

/**
 * The world slices that change when the overrides go from `current` to
 * `next`: every key in `next` is written, and every key only `current` had is
 * put back to the seed. Writes chain, so two fields over one entity -- an
 * event's date and its time -- each see the other's result.
 */
export function projectContentOverrides(
  world: ContentWorld,
  current: ContentOverrides,
  next: ContentOverrides,
): Partial<ContentWorld> {
  let projected: ContentWorld = world;
  let patch: Partial<ContentWorld> = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    const target = parseContentKey(key);
    const definition = target === undefined ? undefined : definitionById.get(target.id);
    if (target === undefined || definition === undefined) continue;
    const value = next[key] ?? definition.read(seedWorld, target.entityId);
    if (value === undefined) continue;
    const written = definition.write(projected, target.entityId, value);
    if (written === undefined) continue;
    projected = { ...projected, ...written };
    patch = { ...patch, ...written };
  }
  return patch;
}
