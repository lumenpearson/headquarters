import { createHash } from 'node:crypto';

import { create, toJson, type MessageInitShape } from '@bufbuild/protobuf';
import { settingsV1, type SettingValueSchema } from '@gremuchaya/protocol';
import {
  settingsDefinitions,
  type SettingDefinition,
  type SettingValue,
} from '@gremuchaya/settings-schema';

/**
 * The descriptor set `GetSettingsSchema` answers with.
 *
 * The control plane authors no settings of its own: `@gremuchaya/settings-schema`
 * is the single registry, shared by the client that renders the controls and by
 * this process, so a descriptor served here can never drift from the definition
 * the operator is editing. A second, hand-maintained copy in this package would
 * be exactly that drift, and it is why the RPC previously answered
 * `unimplemented` in every deployment rather than being given a private schema.
 *
 * The mapping is deliberately narrow. Only what the registry actually declares
 * crosses the wire; nothing is invented to fill a field, because a descriptor
 * carrying a made-up value is worse for a client than one carrying none.
 */
export function controlPlaneSettingsSchema(
  definitions: readonly SettingDefinition[] = settingsDefinitions,
): settingsV1.SettingsSchema {
  // Sorted by path so the descriptor list -- and therefore the version derived
  // from it -- depends on the registry's content and not on its declaration
  // order. Reordering two definitions must not invalidate every client's cache.
  const sorted = [...definitions].sort((left, right) => (left.id < right.id ? -1 : 1));
  const settings = sorted.map(toDescriptor);
  const categories: string[] = [];
  for (const definition of sorted) {
    if (!categories.includes(definition.category)) categories.push(definition.category);
  }

  const withoutVersion = create(settingsV1.SettingsSchemaSchema, {
    version: '',
    settings,
    categories,
  });
  return create(settingsV1.SettingsSchemaSchema, {
    version: schemaVersionOf(withoutVersion),
    settings,
    categories,
  });
}

/**
 * A version a client can cache against, derived from the descriptors themselves.
 *
 * A hand-written version string would have to be remembered on every registry
 * edit, and a forgotten bump serves a stale schema under a fresh name. Hashing
 * the canonical JSON form of the descriptor set makes the version a fact about
 * the content: any change to any descriptor produces a different one, and no
 * change produces the same one on every process that serves it.
 */
function schemaVersionOf(schema: settingsV1.SettingsSchema): string {
  const canonical = JSON.stringify(toJson(settingsV1.SettingsSchemaSchema, schema));
  return `hq-settings-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function toDescriptor(definition: SettingDefinition): settingsV1.SettingDescriptor {
  const editor = definition.editor;
  return create(settingsV1.SettingDescriptorSchema, {
    path: definition.id,
    category: definition.category,
    // The registry declares no localization key: the client derives a label
    // from the path itself. Emitting an invented key here would create a second
    // source of truth that no message catalogue answers.
    localizationKey: '',
    valueType: valueTypeOf(definition),
    defaultValue: toSettingValue(definition.defaultValue),
    // Only `group` definitions may be published to a group document; the store
    // enforces the same rule, and a descriptor that claimed otherwise would
    // invite a client to offer a control the write path then refuses.
    groupSyncAllowed: definition.scope === 'group',
    // Nothing in the registry declares a restart requirement, so this stays
    // false rather than being guessed per category.
    requiresRestart: false,
    ...(editor.kind === 'number'
      ? {
          constraint: create(settingsV1.SettingConstraintSchema, {
            minimum: editor.minimum,
            maximum: editor.maximum,
            step: editor.step,
          }),
        }
      : {}),
    ...(editor.kind === 'enum'
      ? {
          constraint: create(settingsV1.SettingConstraintSchema, {
            allowedValues: [...editor.options],
          }),
        }
      : {}),
  });
}

/**
 * `INTEGER` is never produced: the registry stores every numeric setting as a
 * JavaScript number, and a descriptor promising an integer for a value the
 * validator accepts as fractional would be a narrower claim than the code makes.
 * Integrality, where it matters, travels as the constraint's `step`.
 */
function valueTypeOf(definition: SettingDefinition): settingsV1.SettingValueType {
  switch (definition.editor.kind) {
    case 'boolean':
      return settingsV1.SettingValueType.BOOLEAN;
    case 'number':
      return settingsV1.SettingValueType.NUMBER;
    case 'string-list':
    case 'curve':
      return settingsV1.SettingValueType.STRING_LIST;
    case 'enum':
    case 'material':
      return settingsV1.SettingValueType.STRING;
  }
}

function toSettingValue(value: SettingValue): MessageInitShape<typeof SettingValueSchema> {
  if (typeof value === 'boolean') return { kind: { case: 'booleanValue', value } };
  if (typeof value === 'number') return { kind: { case: 'numberValue', value } };
  if (typeof value === 'string') return { kind: { case: 'stringValue', value } };
  return { kind: { case: 'stringList', value: { values: [...value] } } };
}
