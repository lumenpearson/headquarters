import { telemetryV1 } from '@gremuchaya/protocol';

/**
 * How a published simulation profile declares the data sources a group exposes.
 *
 * There is no `RegisterDataSource` RPC in the contract and this change adds
 * none, so the registry cannot be written directly. What it can be written from
 * is the thing that already names sources: every `SimulationChannel` of a
 * published `SimulationProfile` carries a `source_id`, and a channel is exactly
 * a description of how that source reads. The profile lifecycle is therefore
 * the registry lifecycle -- publishing a profile declares its sources, updating
 * one re-declares them, deleting one takes them away by cascade -- and there is
 * no second path that could leave the two out of step.
 *
 * `SimulationChannel` carries no display name, no unit and no kind, so those
 * three are derived here from the source key's own namespace. The derivation is
 * a small documented convention rather than an invention with no rule behind
 * it: `cpu.total` is a CPU reading in percent under every naming scheme this
 * repository has ever used for it, and a key outside the catalogue is reported
 * as `SIMULATED` with no unit rather than being guessed at.
 */
export interface TelemetrySourceDeclaration {
  /** The `SimulationChannel.source_id` value, verbatim; the registry's key. */
  readonly sourceKey: string;
  readonly name: string;
  /** The `DataSourceKind` enum name without its prefix, as `preset_kind` is stored. */
  readonly kind: string;
  readonly unit: string;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Which channel of the profile drives the source. It is stored so a capture
   * addresses the channel directly instead of re-scanning the body for a
   * matching `source_id`, and so a profile whose channels were reordered still
   * evaluates the source the declaration was made from.
   */
  readonly channelIndex: number;
}

/** The longest source key the registry accepts; a key is an identifier, not a payload. */
export const maxSourceKeyLength = 120;

interface SourceKindShape {
  readonly kind: string;
  readonly unit: string;
}

/**
 * The namespace catalogue.
 *
 * A unit is a symbol rather than prose, so it needs no locale and a client may
 * render it beside the number unchanged. Percentages cover the four saturation
 * readings because that is how a channel with `minimum: 0, maximum: 100`
 * already reads; a channel that declares another range still reports the
 * namespace's unit, because the unit belongs to what is measured and not to the
 * range chosen for it.
 */
const sourceKindsByNamespace: ReadonlyMap<string, SourceKindShape> = new Map([
  ['cpu', { kind: 'CPU', unit: '%' }],
  ['memory', { kind: 'MEMORY', unit: '%' }],
  ['ram', { kind: 'MEMORY', unit: '%' }],
  ['storage', { kind: 'STORAGE', unit: '%' }],
  ['disk', { kind: 'STORAGE', unit: '%' }],
  ['network', { kind: 'NETWORK', unit: 'Mbit/s' }],
  ['net', { kind: 'NETWORK', unit: 'Mbit/s' }],
  ['gpu', { kind: 'GPU', unit: '%' }],
  ['temperature', { kind: 'TEMPERATURE', unit: '°C' }],
  ['temp', { kind: 'TEMPERATURE', unit: '°C' }],
  ['power', { kind: 'POWER', unit: 'W' }],
  ['process', { kind: 'PROCESS', unit: '' }],
  ['proc', { kind: 'PROCESS', unit: '' }],
  ['queue', { kind: 'QUEUE', unit: '' }],
]);

const fallbackSourceKind: SourceKindShape = { kind: 'SIMULATED', unit: '' };

/**
 * Reads the source declarations out of a profile the service has already
 * validated.
 *
 * Duplicates are dropped rather than refused, keeping the first channel that
 * named the key. Two channels may legitimately drive one source under different
 * curves while an operator edits a profile, and refusing the publish would make
 * an intermediate state unsavable; what may not happen is two registry rows for
 * one key, because `ON CONFLICT DO UPDATE` cannot affect one row twice in a
 * single statement and PostgreSQL raises rather than picking a winner.
 *
 * A channel with no `source_id` declares nothing: it still contributes to a
 * preview, but there is no key to register it under, and a blank key would
 * collide with every other blank one in the profile.
 */
export function declaredSources(
  profile: telemetryV1.SimulationProfile,
  presetKindName: string,
): readonly TelemetrySourceDeclaration[] {
  const declarations: TelemetrySourceDeclaration[] = [];
  const seen = new Set<string>();
  profile.channels.forEach((channel, channelIndex) => {
    const sourceKey = channel.sourceId?.value.trim() ?? '';
    if (sourceKey.length === 0 || sourceKey.length > maxSourceKeyLength) return;
    if (seen.has(sourceKey)) return;
    seen.add(sourceKey);
    const shape = sourceKindShapeFor(sourceKey);
    declarations.push({
      sourceKey,
      // The key is the name until something declares a better one. An empty
      // name would leave a client with a row it cannot label at all, and the
      // key is what an operator already reads in the profile editor.
      name: sourceKey,
      kind: shape.kind,
      unit: shape.unit,
      // Both labels are facts about the declaration rather than decoration: they
      // are what tells an operator which of a group's profiles a source came
      // from when two of them name it.
      labels: { profile: profile.name, preset: presetKindName },
      channelIndex,
    });
  });
  return declarations;
}

/**
 * The kind and unit a source key implies.
 *
 * The namespace is the part before the first separator, so `cpu.total`,
 * `cpu/total` and `cpu:0` all read as CPU while `cpu-total` does not -- a
 * hyphen is a word separator inside a segment, not between segments.
 */
export function sourceKindShapeFor(sourceKey: string): SourceKindShape {
  const namespace = sourceKey.toLowerCase().split(/[./:]/u)[0] ?? '';
  return sourceKindsByNamespace.get(namespace) ?? fallbackSourceKind;
}

/**
 * The stored kind name, read back onto the wire enum.
 *
 * The mapping is exhaustive rather than a reverse enum lookup, for the reason
 * `presetKindName` gives: a lookup answers `undefined` for any name a later
 * schema writes, and an unnamed kind is indistinguishable from an unset one.
 * A row whose kind this process does not know reads as `UNSPECIFIED`, which a
 * client can draw; it cannot read as a kind it is not.
 */
export function toDataSourceKind(kind: string): telemetryV1.DataSourceKind {
  switch (kind) {
    case 'CPU':
      return telemetryV1.DataSourceKind.CPU;
    case 'MEMORY':
      return telemetryV1.DataSourceKind.MEMORY;
    case 'STORAGE':
      return telemetryV1.DataSourceKind.STORAGE;
    case 'NETWORK':
      return telemetryV1.DataSourceKind.NETWORK;
    case 'GPU':
      return telemetryV1.DataSourceKind.GPU;
    case 'TEMPERATURE':
      return telemetryV1.DataSourceKind.TEMPERATURE;
    case 'POWER':
      return telemetryV1.DataSourceKind.POWER;
    case 'PROCESS':
      return telemetryV1.DataSourceKind.PROCESS;
    case 'QUEUE':
      return telemetryV1.DataSourceKind.QUEUE;
    case 'SIMULATED':
      return telemetryV1.DataSourceKind.SIMULATED;
    default:
      return telemetryV1.DataSourceKind.UNSPECIFIED;
  }
}
