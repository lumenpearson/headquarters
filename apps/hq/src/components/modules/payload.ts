export type Payload = Readonly<Record<string, unknown>>;

export function textValue(payload: Payload, key: string, fallback = '—'): string {
  const value = payload[key];
  return typeof value === 'string' ? value : fallback;
}

export function numberValue(payload: Payload, key: string, fallback = 0): number {
  const value = payload[key];
  return typeof value === 'number' ? value : fallback;
}

export function booleanValue(payload: Payload, key: string, fallback = false): boolean {
  const value = payload[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function recordValue(payload: Payload, key: string): Payload {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

export function recordArray(payload: Payload, key: string): readonly Payload[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is Payload =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}

export function stringArray(payload: Payload, key: string): readonly string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function matrix(payload: Payload, key: string): readonly (readonly (string | number)[])[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is readonly (string | number)[] =>
      Array.isArray(row) &&
      row.every((cell) => typeof cell === 'string' || typeof cell === 'number'),
  );
}
