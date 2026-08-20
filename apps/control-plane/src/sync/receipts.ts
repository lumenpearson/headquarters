/**
 * Durable idempotency receipts for destructive lifecycle mutations.
 *
 * A receipt records that one client-supplied `MutationContext.request_id`
 * already performed its mutation. It deliberately stores no response: pairing
 * and refresh responses carry raw credentials, and persisting them would move
 * bearer secrets from "never stored" to "stored for the receipt retention
 * window". What is stored is a purpose-separated hash of the request
 * identifier, an opaque fingerprint of the semantic request payload, and the
 * identity of the rows the mutation produced.
 *
 * A retry is therefore answered by re-issuing credentials for the recorded
 * session rather than by returning the original bytes. The client observes the
 * property it actually needs — the mutation ran exactly once and it holds
 * usable credentials for it — while the server keeps its no-credential-at-rest
 * guarantee.
 */

/** Mutations that currently persist a receipt. */
export type MutationScope = 'PAIR_DEVICE' | 'REFRESH_DEVICE_SESSION';

/**
 * The subset of `gremuchaya.common.v1.MutationContext` that reaches the
 * lifecycle boundary. `correlationId` is response metadata and is deliberately
 * excluded: it must not change idempotency identity or the request
 * fingerprint.
 */
export interface MutationReceiptContext {
  readonly requestId: string;
}

/** One named component of a request fingerprint. */
export type FingerprintField = readonly [name: string, value: string];

/**
 * Bounded so a client cannot use the request identifier as unmetered storage.
 * A UUID, a ULID and a Connect request id all fit comfortably.
 */
export const maxRequestIdLength = 200;

export class MutationRequestIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationRequestIdError';
  }
}

/**
 * Normalizes a protobuf request identifier. An absent or empty value is the
 * proto3 default for a client that has not opted into retries, so it disables
 * receipt handling instead of failing the call.
 */
export function normalizeRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim() ?? '';
  if (normalized.length === 0) return undefined;
  if (normalized.length > maxRequestIdLength) {
    throw new MutationRequestIdError(
      `request_id must not exceed ${maxRequestIdLength.toString()} characters`,
    );
  }
  return normalized;
}

/**
 * Length-prefixes every component so no field value can imitate a field
 * boundary. Without this, a device named `x public_key` could produce the same
 * fingerprint as a different request and be accepted as its retry.
 */
export function encodeFingerprintPayload(
  scope: MutationScope,
  fields: readonly FingerprintField[],
): string {
  const parts = [encodePart(scope)];
  for (const [name, value] of fields) {
    parts.push(encodePart(name), encodePart(value));
  }
  return parts.join('');
}

/** Scopes the request identifier so one value cannot collide across operations. */
export function encodeRequestIdPayload(scope: MutationScope, requestId: string): string {
  return `${encodePart(scope)}${encodePart(requestId)}`;
}

function encodePart(value: string): string {
  return `${value.length.toString()}:${value}|`;
}
