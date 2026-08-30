import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { ControlPlaneFailure, ControlPlaneFailureDetailSchema } from '@gremuchaya/protocol';

import type { Awaitable } from './sync/lifecycle.js';
import { PairedDeviceRuntimeError, type PairedDeviceErrorCode } from './sync/runtime.js';

/**
 * Every failure code except the zero value.
 *
 * `UNSPECIFIED` exists because proto3 requires a zero value; sending it would
 * hand a device a code that names nothing, which is the situation this whole
 * mechanism exists to remove. Excluding it from the type means no call site can
 * choose it.
 */
export type ControlPlaneFailureCode = Exclude<ControlPlaneFailure, ControlPlaneFailure.UNSPECIFIED>;

interface ControlPlaneFailureShape {
  /** The Connect status this code answers with. */
  readonly status: Code;
  /**
   * Developer-facing English, and the default when a raiser supplies none.
   *
   * Never displayed. Rewording one of these must not change what an operator
   * reads, which is the entire point of putting a code beside it.
   */
  readonly developerMessage: string;
}

/**
 * The closed vocabulary, and what makes it closed.
 *
 * `Record<ControlPlaneFailureCode, …>` is total over the generated enum, so
 * adding a value to `ControlPlaneFailure` in `control.proto` and regenerating
 * fails to compile here until it is given a status and a sentence. Combined
 * with `controlPlaneFailureInterceptor`, which codes anything that reaches the
 * transport uncoded, that is what makes "no failure reaches a device without a
 * code" a property of the type system rather than of review.
 */
const failures: Readonly<Record<ControlPlaneFailureCode, ControlPlaneFailureShape>> = {
  [ControlPlaneFailure.INTERNAL]: {
    status: Code.Internal,
    developerMessage: 'The control plane failed to complete the request.',
  },
  [ControlPlaneFailure.BEARER_TOKEN_REQUIRED]: {
    status: Code.Unauthenticated,
    developerMessage: 'A bearer access token is required.',
  },
  [ControlPlaneFailure.BOOTSTRAP_AUTHORIZATION_REQUIRED]: {
    status: Code.Unauthenticated,
    developerMessage: 'Bootstrap authorization is required.',
  },
  [ControlPlaneFailure.SESSION_UNAUTHENTICATED]: {
    status: Code.Unauthenticated,
    developerMessage: 'The presented credential does not authenticate a session.',
  },
  [ControlPlaneFailure.PERMISSION_DENIED]: {
    status: Code.PermissionDenied,
    developerMessage: 'The authenticated device may not perform this operation.',
  },
  [ControlPlaneFailure.NOT_FOUND]: {
    status: Code.NotFound,
    developerMessage: 'The requested resource does not exist.',
  },
  [ControlPlaneFailure.ALREADY_EXISTS]: {
    status: Code.AlreadyExists,
    developerMessage: 'The resource already exists.',
  },
  [ControlPlaneFailure.INVALID_ARGUMENT]: {
    status: Code.InvalidArgument,
    developerMessage: 'The request was rejected as stated.',
  },
  [ControlPlaneFailure.FAILED_PRECONDITION]: {
    status: Code.FailedPrecondition,
    developerMessage: 'The group is not in a state that admits this operation.',
  },
  [ControlPlaneFailure.CONCURRENT_MODIFICATION]: {
    status: Code.Aborted,
    developerMessage: 'A concurrent mutation won the row; retry against the current revision.',
  },
  [ControlPlaneFailure.RATE_LIMITED]: {
    status: Code.ResourceExhausted,
    developerMessage:
      'The group publication rate limit has been reached; retry after the window resets.',
  },
  [ControlPlaneFailure.REPLAY_WINDOW_EXCEEDED]: {
    status: Code.OutOfRange,
    developerMessage: 'The requested resume point is no longer retained; request a snapshot.',
  },
  [ControlPlaneFailure.GROUP_ADMINISTRATION_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without group administration.',
  },
  [ControlPlaneFailure.PRESENCE_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without presence storage.',
  },
  [ControlPlaneFailure.EVENT_LOG_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without a durable event log.',
  },
  [ControlPlaneFailure.REALTIME_HUB_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without a realtime hub.',
  },
  [ControlPlaneFailure.SETTINGS_SCHEMA_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without a settings schema.',
  },
  [ControlPlaneFailure.SETTINGS_STORAGE_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without durable settings storage.',
  },
  [ControlPlaneFailure.INTEGRATION_STORAGE_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without integration storage.',
  },
  [ControlPlaneFailure.INTEGRATION_GITHUB_UNAVAILABLE]: {
    status: Code.Unimplemented,
    developerMessage: 'This control plane was started without GitHub egress.',
  },
  [ControlPlaneFailure.INTEGRATION_GITHUB_UNREACHABLE]: {
    status: Code.Unavailable,
    developerMessage: 'The GitHub request did not complete.',
  },
};

/**
 * The one place a control-plane `ConnectError` is built, so no refusal can leave
 * without a detail naming its code.
 *
 * `developerMessage` overrides the code's own sentence where the raiser knows
 * more -- a runtime refusal names the field or the limit it refused on -- and it
 * is the *only* thing that varies. `cause` stays in this process: Connect does
 * not serialize it, which is exactly why the underlying exception belongs there
 * and not in the message.
 */
export function controlPlaneFailure(
  code: ControlPlaneFailureCode,
  options?: { readonly developerMessage?: string; readonly cause?: unknown },
): ConnectError {
  const shape = failures[code];
  const developerMessage = options?.developerMessage ?? shape.developerMessage;
  return new ConnectError(
    developerMessage,
    shape.status,
    undefined,
    [{ desc: ControlPlaneFailureDetailSchema, value: { code, developerMessage } }],
    options?.cause,
  );
}

/**
 * The seven runtime refusal classes, each on its own code.
 *
 * `PairedDeviceRuntimeError` is raised in 245 places and carries one of these
 * seven; that coarseness is deliberate and belongs to the runtime, not to this
 * mapping. `UNAUTHENTICATED` in particular covers no-such-token, retired,
 * rotated, replayed, revoked and expired without distinguishing them, because
 * distinguishing them is the oracle the neutral message exists to deny.
 *
 * The `never` on the last line is what keeps this exhaustive: adding a member to
 * `PairedDeviceErrorCode` fails to compile here.
 */
export function toControlPlaneFailureCode(code: PairedDeviceErrorCode): ControlPlaneFailureCode {
  switch (code) {
    case 'ABORTED':
      return ControlPlaneFailure.CONCURRENT_MODIFICATION;
    case 'ALREADY_EXISTS':
      return ControlPlaneFailure.ALREADY_EXISTS;
    case 'FAILED_PRECONDITION':
      return ControlPlaneFailure.FAILED_PRECONDITION;
    case 'INVALID_ARGUMENT':
      return ControlPlaneFailure.INVALID_ARGUMENT;
    case 'NOT_FOUND':
      return ControlPlaneFailure.NOT_FOUND;
    case 'PERMISSION_DENIED':
      return ControlPlaneFailure.PERMISSION_DENIED;
    case 'UNAUTHENTICATED':
      return ControlPlaneFailure.SESSION_UNAUTHENTICATED;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/**
 * Turns anything thrown inside a handler into a coded `ConnectError`.
 *
 * The last branch is the one that changed behaviour. It used to be `throw
 * error`, which let a driver exception reach Connect and be rendered as
 * `unknown` carrying its own message -- and a `pg` error message quotes the
 * statement it failed on. The exception is now kept as `cause`, where the
 * process's own logging can still reach it, and the wire carries a code.
 */
export function toControlPlaneConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof PairedDeviceRuntimeError) {
    return controlPlaneFailure(toControlPlaneFailureCode(error.code), {
      developerMessage: error.message,
      cause: error,
    });
  }
  return controlPlaneFailure(ControlPlaneFailure.INTERNAL, { cause: error });
}

/**
 * The wrapper every RPC handler puts around its body.
 *
 * One copy, shared by all five services: it used to be five identical private
 * copies, which is five places for the classification of a refusal to drift.
 */
export async function withRuntimeErrors<T>(operation: () => Awaitable<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw toControlPlaneConnectError(error);
  }
}

/**
 * The router-wide guarantee that no failure leaves this process uncoded.
 *
 * `withRuntimeErrors` is a convention that one handler -- `WatchGroup` -- did
 * not follow, so an unauthenticated socket subscription answered Connect's own
 * `unknown` carrying the runtime's raw message instead of `unauthenticated`. An
 * interceptor is applied to every registered method, including ones added later,
 * which is the difference between an invariant and a habit.
 *
 * A `ConnectError` passes through untouched: it either already carries this
 * control plane's detail, or it is Connect's own -- a cancellation, a protocol
 * error, or the `unimplemented` a reduced startup answers for a service it never
 * registered -- and the client derives a code from the transport status for
 * exactly that case.
 */
export const controlPlaneFailureInterceptor: Interceptor = (next) => async (request) => {
  let response;
  try {
    response = await next(request);
  } catch (error: unknown) {
    throw toControlPlaneConnectError(error);
  }
  // A server-streaming implementation is an async generator: calling it does
  // not run its body, so `WatchGroup`'s prologue -- which authenticates -- runs
  // while the response is iterated, long after `next` resolved.
  return response.stream
    ? { ...response, message: codeStreamFailures(response.message) }
    : response;
};

async function* codeStreamFailures<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
  try {
    yield* stream;
  } catch (error: unknown) {
    throw toControlPlaneConnectError(error);
  }
}
