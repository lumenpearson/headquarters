import { Code, ConnectError } from '@connectrpc/connect';
import { ControlPlaneFailure, ControlPlaneFailureDetailSchema } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import {
  controlPlaneFailure,
  toControlPlaneConnectError,
  toControlPlaneFailureCode,
  type ControlPlaneFailureCode,
} from './errors.js';
import { PairedDeviceRuntimeError, type PairedDeviceErrorCode } from './sync/runtime.js';

/**
 * Every code the contract declares, minus the zero value the server may not
 * send. Derived from the generated enum rather than written out, so a code added
 * to `control.proto` joins these assertions without anyone remembering to add
 * it -- which is the half of "closed and exhaustive" a review cannot supply.
 */
const declaredCodes: readonly ControlPlaneFailureCode[] = Object.values(ControlPlaneFailure)
  .filter((value): value is ControlPlaneFailure => typeof value === 'number')
  .filter((value): value is ControlPlaneFailureCode => value !== ControlPlaneFailure.UNSPECIFIED);

/**
 * What each of the runtime's seven refusal classes must become.
 *
 * Written out rather than read from `toControlPlaneFailureCode`, so this is an
 * assertion about the mapping and not a restatement of it. It is typed
 * `Record<PairedDeviceErrorCode, …>`, so a member added to the runtime's own
 * union fails to compile here.
 */
const runtimeExpectations: Readonly<Record<PairedDeviceErrorCode, ControlPlaneFailureCode>> = {
  ABORTED: ControlPlaneFailure.CONCURRENT_MODIFICATION,
  ALREADY_EXISTS: ControlPlaneFailure.ALREADY_EXISTS,
  FAILED_PRECONDITION: ControlPlaneFailure.FAILED_PRECONDITION,
  INVALID_ARGUMENT: ControlPlaneFailure.INVALID_ARGUMENT,
  NOT_FOUND: ControlPlaneFailure.NOT_FOUND,
  PERMISSION_DENIED: ControlPlaneFailure.PERMISSION_DENIED,
  UNAUTHENTICATED: ControlPlaneFailure.SESSION_UNAUTHENTICATED,
};

const runtimeCodes = Object.keys(runtimeExpectations) as readonly PairedDeviceErrorCode[];

describe('control-plane failure codes', () => {
  it('declares more than the zero value', () => {
    expect(declaredCodes.length).toBeGreaterThan(20);
  });

  it.each(declaredCodes)('gives code %i a detail, a status and a sentence', (code) => {
    const error = controlPlaneFailure(code);
    const [detail] = error.findDetails(ControlPlaneFailureDetailSchema);
    expect(detail?.code).toBe(code);
    expect(detail?.developerMessage).not.toBe('');
    expect(error.rawMessage).toBe(detail?.developerMessage);
    expect(error.code).not.toBe(Code.Unknown);
  });

  it.each(runtimeCodes)('carries a runtime %s refusal on its own code', (runtimeCode) => {
    const error = toControlPlaneConnectError(
      new PairedDeviceRuntimeError(runtimeCode, 'group_id must not be empty.'),
    );
    const [detail] = error.findDetails(ControlPlaneFailureDetailSchema);

    expect(toControlPlaneFailureCode(runtimeCode)).toBe(runtimeExpectations[runtimeCode]);
    expect(detail?.code).toBe(runtimeExpectations[runtimeCode]);
    // The runtime's own sentence is what the diagnostics copy needs: it names
    // the field or the limit, which the code deliberately does not.
    expect(detail?.developerMessage).toBe('group_id must not be empty.');
    expect(error.rawMessage).toBe('group_id must not be empty.');
  });

  it('keeps the seven runtime classes on seven distinct codes', () => {
    // A collision would merge two refusals into one caption, which is how a
    // "this device may not" becomes indistinguishable from a "no such group".
    const codes = runtimeCodes.map((runtimeCode) => toControlPlaneFailureCode(runtimeCode));
    expect(new Set(codes).size).toBe(runtimeCodes.length);
  });

  it('classifies an unrecognised exception without quoting it', () => {
    // The shape a driver raises. Before codes this reached the client as
    // Connect's `unknown` carrying the statement text verbatim.
    const raw = new Error('error: relation "device_access_tokens" does not exist');
    const error = toControlPlaneConnectError(raw);

    expect(error.findDetails(ControlPlaneFailureDetailSchema)[0]?.code).toBe(
      ControlPlaneFailure.INTERNAL,
    );
    expect(error.code).toBe(Code.Internal);
    expect(error.rawMessage).not.toContain('device_access_tokens');
    // The original stays reachable in-process for this deployment's own logs.
    expect(error.cause).toBe(raw);
  });

  it('leaves a ConnectError alone so a cancellation stays a cancellation', () => {
    const canceled = new ConnectError('operation canceled', Code.Canceled);
    expect(toControlPlaneConnectError(canceled)).toBe(canceled);
  });

  it('lets a raiser override the sentence and never the code', () => {
    const error = controlPlaneFailure(ControlPlaneFailure.RATE_LIMITED, {
      developerMessage: 'Publication limit reached for group 42.',
    });
    const [detail] = error.findDetails(ControlPlaneFailureDetailSchema);
    expect(detail?.code).toBe(ControlPlaneFailure.RATE_LIMITED);
    expect(detail?.developerMessage).toBe('Publication limit reached for group 42.');
    expect(error.code).toBe(Code.ResourceExhausted);
  });
});
