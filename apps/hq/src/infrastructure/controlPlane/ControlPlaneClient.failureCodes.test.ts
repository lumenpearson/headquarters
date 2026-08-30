import { Code, ConnectError } from '@connectrpc/connect';
import {
  ControlPlaneFailure,
  ControlPlaneFailureDetailSchema,
  BridgeFailureDetailSchema,
} from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import {
  ControlPlaneError,
  controlPlaneErrorKinds,
  type ControlPlaneErrorCode,
} from '@/application/sync/controlPlanePort';

import { toControlPlaneError } from './ControlPlaneClient';

/**
 * Every code the contract declares, minus the zero value the control plane may
 * not send. Derived from the generated enum, so a code added to `control.proto`
 * joins these assertions on its own.
 */
const declaredCodes = Object.values(ControlPlaneFailure)
  .filter((value): value is ControlPlaneFailure => typeof value === 'number')
  .filter((value) => value !== ControlPlaneFailure.UNSPECIFIED);

function refusal(code: number, status = Code.Internal, message = 'developer prose'): ConnectError {
  return new ConnectError(message, status, undefined, [
    { desc: ControlPlaneFailureDetailSchema, value: { code, developerMessage: message } },
  ]);
}

describe('control-plane wire codes', () => {
  it.each(declaredCodes)('lands wire code %i on a named code and a kind', (code) => {
    const error = toControlPlaneError(refusal(code));

    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error.code).not.toBe('unknown');
    expect(controlPlaneErrorKinds[error.code]).toBe(error.kind);
  });

  it('reads the code from the detail rather than from the transport status', () => {
    // `Unimplemented` and `settings-storage-unavailable` agree here, which is
    // the point: the status is coarse and the code is what a caption keys on.
    const error = toControlPlaneError(
      refusal(ControlPlaneFailure.SETTINGS_STORAGE_UNAVAILABLE, Code.Unimplemented),
    );

    expect(error.code).toBe('settings-storage-unavailable');
    expect(error.kind).toBe('unimplemented');
  });

  /*
   * The one that matters on a shoot day. A control plane newer than this build
   * sends a number this build has no name for; proto3 enums are open, so this
   * is expected traffic and not corruption. It must degrade to the generic
   * code, never to `undefined`, and above all must not throw -- an exception
   * raised while handling an exception is how a screen goes white.
   */
  it('degrades an unrecognised wire code to the generic one without throwing', () => {
    const error = toControlPlaneError(refusal(9_999, Code.Aborted));

    // The transport status is still meaningful, so it is what answers.
    expect(error.code).toBe('concurrent-modification');
    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('developer prose');
  });

  it('degrades an unrecognised wire code with an unrecognised status too', () => {
    // Nothing left to fall back on. The answer is still a code.
    const error = toControlPlaneError(refusal(9_999, 42 as Code));

    expect(error.code).toBe('unknown');
    expect(error.kind).toBe('unknown');
  });

  it('ignores a detail of a type this build cannot decode', () => {
    // `findDetails` drops what it cannot decode rather than raising, so a
    // detail meant for another server leaves the transport status in charge.
    const foreign = new ConnectError('developer prose', Code.NotFound, undefined, [
      { desc: BridgeFailureDetailSchema, value: { code: 3, developerMessage: 'not ours' } },
    ]);

    const error = toControlPlaneError(foreign);

    expect(error.code).toBe('not-found');
    expect(error.kind).toBe('not-found');
  });

  it('gives a refusal that carried no detail at all a code from its status', () => {
    // What a control plane older than these codes answers, and what Connect
    // itself answers for a service a reduced startup never registered.
    const error = toControlPlaneError(new ConnectError('no such method', Code.Unimplemented));

    expect(error.code).toBe('unimplemented');
    expect(error.kind).toBe('unimplemented');
  });

  it('gives a failure that never reached the wire a code', () => {
    const error = toControlPlaneError(new TypeError('Failed to fetch'));

    expect(error.code).toBe('unavailable');
    expect(error.kind).toBe('unavailable');
  });

  /*
   * Four adapters raise `ControlPlaneError` for failures that never crossed a
   * wire -- no stored session, a response missing a field, a reader link asked
   * to write credentials. They name a kind and nothing else, and `code` has to
   * be present on those too, or a render site has to ask whether one arrived.
   */
  it.each(Object.keys(controlPlaneErrorKinds) as ControlPlaneErrorCode[])(
    'gives an error raised with the kind of %s a code of its own',
    (code) => {
      const raised = new ControlPlaneError(controlPlaneErrorKinds[code], 'No paired session.');

      expect(raised.code).toBeDefined();
      expect(controlPlaneErrorKinds[raised.code]).toBe(raised.kind);
    },
  );

  it('names the kind an adapter chose when it names no code', () => {
    expect(new ControlPlaneError('unauthenticated', 'No paired session.').code).toBe(
      'session-unauthenticated',
    );
  });

  it('keeps the developer prose reachable for the diagnostics copy', () => {
    const error = toControlPlaneError(
      refusal(
        ControlPlaneFailure.RATE_LIMITED,
        Code.ResourceExhausted,
        'The group publication rate limit has been reached; retry after the window resets.',
      ),
    );

    // Not for display -- the caption comes from `code` -- but it must still be
    // there, or the diagnostics copy loses the only thing that names the limit.
    expect(error.message).toBe(
      'The group publication rate limit has been reached; retry after the window resets.',
    );
    expect(error.code).toBe('rate-limited');
  });
});
