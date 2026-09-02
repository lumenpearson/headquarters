import { Code, ConnectError } from '@connectrpc/connect';
import {
  BridgeFailure,
  BridgeFailureDetailSchema,
  ControlPlaneFailureDetailSchema,
} from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { BridgeFileError, toBridgeFileError } from './BridgeFileSource';

/**
 * Every code the contract declares, minus the zero value the bridge may not
 * send. Derived from the generated enum, so a code added to `bridge.proto`
 * joins these assertions on its own.
 */
const declaredCodes = Object.values(BridgeFailure)
  .filter((value): value is BridgeFailure => typeof value === 'number')
  .filter((value) => value !== BridgeFailure.UNSPECIFIED);

function refusal(code: number, status = Code.Internal, message = 'developer prose'): ConnectError {
  return new ConnectError(message, status, undefined, [
    { desc: BridgeFailureDetailSchema, value: { code, developerMessage: message } },
  ]);
}

describe('file bridge wire codes', () => {
  it.each(declaredCodes)('lands wire code %i on a named code and a kind', (code) => {
    const error = toBridgeFileError(refusal(code));

    expect(error).toBeInstanceOf(BridgeFileError);
    expect(error.code).not.toBe('unknown');
    expect(error.kind).toBeDefined();
  });

  /*
   * The refusal this whole exercise exists for. The bridge projects a physical
   * tree behind virtual paths so that no physical path reaches the UI (ADR
   * 0002); the code the client reads has to keep that true even if the server's
   * prose one day does not.
   */
  it('carries a traversal refusal as a code that names no location', () => {
    const error = toBridgeFileError(
      refusal(
        BridgeFailure.PATH_REJECTED,
        Code.PermissionDenied,
        'The requested path is not one this bridge will resolve.',
      ),
    );

    expect(error.code).toBe('path-rejected');
    expect(error.kind).toBe('permission-denied');
    expect(error.code).not.toContain('/');
    expect(error.code).not.toContain('\\');
  });

  it('carries a containment refusal on its own code', () => {
    const error = toBridgeFileError(
      refusal(BridgeFailure.PATH_ESCAPES_MOUNT, Code.PermissionDenied),
    );

    expect(error.code).toBe('path-escapes-mount');
    expect(error.kind).toBe('permission-denied');
  });

  /*
   * A bridge newer than this build sends a number this build has no name for.
   * Proto3 enums are open, so that is expected traffic. It must degrade to the
   * generic code, never to `undefined`, and must not throw: this runs on the
   * explorer's error path, which ends at a screen someone is watching.
   */
  it('degrades an unrecognised wire code to the transport status without throwing', () => {
    const error = toBridgeFileError(refusal(9_999, Code.NotFound));

    // The status is still meaningful, so it is what answers.
    expect(error.code).toBe('entry-not-found');
    expect(error.kind).toBe('not-found');
    expect(error.message).toBe('developer prose');
  });

  it('degrades an unrecognised wire code with an unrecognised status too', () => {
    // Nothing left to fall back on. The gRPC-Web decoder parses `grpc-status`
    // as an integer, so a status outside `Code` is reachable from the wire and
    // the answer still has to be a code rather than `undefined`.
    const error = toBridgeFileError(refusal(9_999, 42 as Code));

    expect(error.code).toBe('unknown');
    expect(error.kind).toBe('unknown');
  });

  it('ignores a detail of a type this build cannot decode', () => {
    const foreign = new ConnectError('developer prose', Code.NotFound, undefined, [
      { desc: ControlPlaneFailureDetailSchema, value: { code: 4, developerMessage: 'not ours' } },
    ]);

    const error = toBridgeFileError(foreign);

    expect(error.code).toBe('entry-not-found');
    expect(error.kind).toBe('not-found');
  });

  it('gives a refusal that carried no detail at all a code from its status', () => {
    const error = toBridgeFileError(new ConnectError('not found', Code.NotFound));

    expect(error.code).toBe('entry-not-found');
  });

  it('gives a bridge that is not running a code', () => {
    // The ordinary state of a machine where the operator never started it.
    const error = toBridgeFileError(new TypeError('Failed to fetch'));

    expect(error.code).toBe('unavailable');
    expect(error.kind).toBe('unavailable');
  });

  it('keeps the developer prose reachable for the diagnostics copy', () => {
    const error = toBridgeFileError(
      refusal(BridgeFailure.MATERIAL_TOO_LARGE, Code.InvalidArgument, 'Material exceeds 5 GiB.'),
    );

    expect(error.message).toBe('Material exceeds 5 GiB.');
    expect(error.code).toBe('material-too-large');
  });
});
