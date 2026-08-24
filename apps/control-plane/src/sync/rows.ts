import type { SqlParameter, SqlStatement } from '../db/database.js';

import { PairedDeviceRuntimeError } from './runtime.js';

/**
 * Readers for values the PostgreSQL driver hands back.
 *
 * They lived as private functions inside `durable-runtime.ts` while exactly one
 * module talked to the database. F6 adds the realtime event store and four
 * services, and each of them decodes the same driver quirks: `bigint` arriving
 * as a string, `jsonb` arriving already parsed or not, `timestamptz` arriving as
 * a `Date` or an ISO string. Copying that decoding into six modules is how one
 * corrected reader turns into five uncorrected ones, so it moves here whole.
 *
 * Every reader raises a plain `Error`, never a `PairedDeviceRuntimeError`: a
 * malformed row is a defect in this repository, not a client-visible outcome,
 * and it must not be mapped onto a Connect status code.
 */

export function sql(text: string, values: readonly SqlParameter[]): SqlStatement {
  return { text, values };
}

export function requireOneRow<Row>(rows: readonly Row[], message: string): Row {
  const row = rows[0];
  if (row === undefined) throw new PairedDeviceRuntimeError('FAILED_PRECONDITION', message);
  return row;
}

export function readText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return value;
}

export function readOptionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

export function readDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`The database returned an invalid ${field}.`);
  return date;
}

export function readOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return readDate(value, field);
}

export function readBigInt(value: unknown, field: string): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe integer');
      return BigInt(value);
    }
    if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  } catch {
    // Normalized error below keeps driver-specific conversion details out of responses.
  }
  throw new Error(`The database returned an invalid ${field}.`);
}

export function readOptionalBigInt(value: unknown, field: string): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  return readBigInt(value, field);
}

export function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`The database returned an invalid ${field}.`);
}

export function readJsonArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  const decoded = readJson(value, field);
  if (!Array.isArray(decoded) || !decoded.every(isRecord)) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return decoded;
}

export function readJsonObject(value: unknown, field: string): Record<string, unknown> {
  const decoded = readJson(value, field);
  if (!isRecord(decoded)) throw new Error(`The database returned an invalid ${field}.`);
  return decoded;
}

export function readJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`The database returned invalid JSON for ${field}.`);
  }
}

export function readTextArray(value: unknown, field: string): readonly string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
  throw new Error(`The database returned an invalid ${field}.`);
}

/**
 * `bytea` reaches this process either as bytes or as the driver's hex escape
 * form. Both are the same value; a caller that handled only one of them would
 * work until the driver or the transport changed under it.
 */
export function readBytes(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && value.startsWith('\\x')) {
    return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
  }
  throw new Error(`The database returned an invalid ${field}.`);
}

export function readOptionalBytes(value: unknown, field: string): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  return readBytes(value, field);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Maps a driver failure onto the lifecycle's own error vocabulary.
 *
 * Serialization and deadlock failures become `ABORTED` because they are
 * retryable by the caller; a unique or foreign-key violation is a statement of
 * fact about the requested state and is not.
 */
export function normalizeDatabaseError(error: unknown): Error {
  if (error instanceof PairedDeviceRuntimeError) return error;
  if (isPostgresError(error, '40P01') || isPostgresError(error, '40001')) {
    return new PairedDeviceRuntimeError(
      'ABORTED',
      'The lifecycle mutation conflicted with a concurrent operation. Retry after refreshing state.',
    );
  }
  if (isPostgresError(error, '23505')) {
    return new PairedDeviceRuntimeError(
      'ALREADY_EXISTS',
      'A record with the supplied unique identifier already exists.',
    );
  }
  if (isPostgresError(error, '23503')) {
    return new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'The requested lifecycle state is no longer available.',
    );
  }
  if (error instanceof Error) return error;
  return new Error('The database rejected the paired-device operation.');
}

export function isPostgresError(error: unknown, expectedCode: string): boolean {
  return isRecord(error) && error.code === expectedCode;
}
