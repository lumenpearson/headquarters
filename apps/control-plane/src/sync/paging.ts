import { PairedDeviceRuntimeError } from './runtime.js';

/**
 * The page size every listing agrees on.
 *
 * There were four copies of this and they did not behave the same: two refused
 * an out-of-range value and two silently clamped it, so one control plane
 * answered `page_size: 5000` with an error from `ListDevices` and with a
 * hundred rows from `ListSimulationProfiles`. A caller cannot write against
 * that.
 *
 * Refusal is the behaviour kept. A clamp looks like success and is not: a
 * client that asked for five thousand rows and received a hundred has no way to
 * tell that from a group with a hundred rows, and will page as if it had them
 * all.
 *
 * Zero is the proto3 default for a client that expressed no preference, so it
 * means "the default", not "none".
 */
export function normalizePageSize(
  requested: number,
  bounds: {
    readonly defaultPageSize: number;
    readonly maxPageSize: number;
    /**
     * The wire field the refusal names. Every listing calls it `page_size`, but
     * the group log is paged by `limit`, and an error that names a field the
     * request does not carry sends the caller looking in the wrong place.
     */
    readonly field?: string;
  },
): number {
  if (requested === 0) return bounds.defaultPageSize;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > bounds.maxPageSize) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `${bounds.field ?? 'page_size'} must be between 1 and ${bounds.maxPageSize.toString()}.`,
    );
  }
  return requested;
}
