import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { AppError } from '@gremuchaya/domain';
import { BridgeFailure, BridgeFailureDetailSchema } from '@gremuchaya/protocol';

/**
 * Every failure code except the zero value.
 *
 * `UNSPECIFIED` exists because proto3 requires a zero value; emitting it would
 * hand the client a code that names nothing, which is the situation this whole
 * mechanism exists to remove. Excluding it from the type means no call site can
 * choose it.
 */
export type BridgeFailureCode = Exclude<BridgeFailure, BridgeFailure.UNSPECIFIED>;

interface BridgeFailureShape {
  /** The Connect status this code answers with. */
  readonly status: Code;
  /**
   * Developer-facing English, fixed per code and never displayed.
   *
   * Fixed, not derived from the caught exception: a Node fs error quotes the
   * absolute path it failed on, and this string crosses to a browser. The
   * exception's own text stays on this side of the wire.
   */
  readonly developerMessage: string;
}

/**
 * The closed vocabulary, and what makes it closed.
 *
 * `Record<BridgeFailureCode, …>` is total over the generated enum, so adding a
 * value to `BridgeFailure` in `bridge.proto` and regenerating fails to compile
 * here until it is given a status and a sentence. That is the structural half of
 * "a new error cannot reach the client without a code"; `toBridgeConnectError`
 * is the other half, and covers everything that was never given one at all.
 */
const failures: Readonly<Record<BridgeFailureCode, BridgeFailureShape>> = {
  [BridgeFailure.INTERNAL]: {
    status: Code.Internal,
    developerMessage: 'The bridge failed to complete the request.',
  },
  [BridgeFailure.MISSING_FIELD]: {
    status: Code.InvalidArgument,
    developerMessage: 'A required request field was empty.',
  },
  [BridgeFailure.PATH_ESCAPES_MOUNT]: {
    status: Code.PermissionDenied,
    developerMessage: 'Requested path escapes the configured mount.',
  },
  [BridgeFailure.SYMLINK_REFUSED]: {
    status: Code.PermissionDenied,
    developerMessage: 'Symbolic links are not exposed by the bridge.',
  },
  [BridgeFailure.INTERNAL_PATH_HIDDEN]: {
    status: Code.PermissionDenied,
    developerMessage: 'Bridge internal material paths are not exposed.',
  },
  [BridgeFailure.MOUNT_UNKNOWN]: {
    status: Code.NotFound,
    developerMessage: 'The request named a mount this bridge does not project.',
  },
  [BridgeFailure.NOT_A_DIRECTORY]: {
    status: Code.InvalidArgument,
    developerMessage: 'Requested path is not a directory.',
  },
  [BridgeFailure.NOT_A_FILE]: {
    status: Code.InvalidArgument,
    developerMessage: 'Requested path is not a file.',
  },
  [BridgeFailure.ENTRY_NOT_FOUND]: {
    status: Code.NotFound,
    developerMessage: 'The requested entry no longer exists in the mount.',
  },
  [BridgeFailure.MATERIAL_IMPORT_DISABLED]: {
    status: Code.FailedPrecondition,
    developerMessage: 'Material imports are disabled for this bridge.',
  },
  [BridgeFailure.MATERIAL_TOO_LARGE]: {
    status: Code.InvalidArgument,
    developerMessage: 'Material exceeds the configured maximum file size.',
  },
  [BridgeFailure.MATERIAL_NAME_UNSAFE]: {
    status: Code.InvalidArgument,
    developerMessage: 'Material file name is unsafe.',
  },
  [BridgeFailure.MATERIAL_CHUNK_REJECTED]: {
    status: Code.InvalidArgument,
    developerMessage: 'The chunk does not continue the resumable upload.',
  },
  [BridgeFailure.MATERIAL_UPLOAD_INCOMPLETE]: {
    status: Code.FailedPrecondition,
    developerMessage: 'Material upload is incomplete.',
  },
  [BridgeFailure.MATERIAL_HASH_MISMATCH]: {
    status: Code.InvalidArgument,
    developerMessage: 'BLAKE3 verification failed for the uploaded material.',
  },
  [BridgeFailure.MATERIAL_SESSION_NOT_FOUND]: {
    status: Code.NotFound,
    developerMessage: 'Material import session was not found.',
  },
  [BridgeFailure.MATERIAL_NOT_FOUND]: {
    status: Code.NotFound,
    developerMessage: 'No imported material answers that identifier.',
  },
  [BridgeFailure.MATERIAL_RECORD_UNREADABLE]: {
    status: Code.FailedPrecondition,
    developerMessage: 'The stored material record cannot be trusted.',
  },
  [BridgeFailure.MATERIAL_MOUNT_UNAVAILABLE]: {
    status: Code.FailedPrecondition,
    developerMessage: 'This bridge projects no material mount.',
  },
  [BridgeFailure.PLAYBACK_UNSUPPORTED_MEDIA]: {
    status: Code.InvalidArgument,
    developerMessage: 'Only audio and video materials can receive a playback grant.',
  },
  [BridgeFailure.PLAYBACK_CAPACITY_REACHED]: {
    status: Code.ResourceExhausted,
    developerMessage: 'Playback grant capacity has been reached.',
  },
  [BridgeFailure.PLAYBACK_UNAVAILABLE]: {
    status: Code.FailedPrecondition,
    developerMessage: 'The bridge cannot mint a playback grant right now.',
  },
  [BridgeFailure.MATERIAL_REQUEST_INVALID]: {
    status: Code.InvalidArgument,
    developerMessage: 'The material request cannot be accepted as stated.',
  },
  [BridgeFailure.PATH_REJECTED]: {
    status: Code.PermissionDenied,
    developerMessage: 'The requested path is not one this bridge will resolve.',
  },
};

/**
 * A refusal raised inside the bridge, carrying the code it will cross the wire
 * with.
 *
 * The code is chosen where the refusal is decided, not at the transport
 * boundary: `server.ts` used to classify by exception class, which is why four
 * classes shared one branch and the branch had nothing to say but
 * `error.message`.
 */
export class BridgeFailureError extends Error {
  constructor(
    readonly code: BridgeFailureCode,
    /** Internal detail for the bridge's own logs. Never crosses the wire. */
    message?: string,
  ) {
    super(message ?? failures[code].developerMessage);
    this.name = 'BridgeFailureError';
  }
}

/**
 * The one place a bridge `ConnectError` is built, so no failure can leave
 * without a detail.
 *
 * `cause` keeps the original exception reachable in-process for logging and is
 * not serialized by Connect.
 */
export function bridgeFailure(code: BridgeFailureCode, cause?: unknown): ConnectError {
  const shape = failures[code];
  return new ConnectError(
    shape.developerMessage,
    shape.status,
    undefined,
    [
      {
        desc: BridgeFailureDetailSchema,
        value: { code, developerMessage: shape.developerMessage },
      },
    ],
    cause,
  );
}

/**
 * Turns anything thrown inside a handler into a coded `ConnectError`.
 *
 * The last branch is the security-relevant one. It used to be
 * `new ConnectError(error.message, …)`, and the errors that reach it are Node
 * `fs` errors whose message is `ENOENT: no such file or directory, open
 * '<absolute path>'` -- the mount root of a shoot machine, delivered to a
 * browser by a server whose entire purpose is that physical paths never reach
 * the UI (ADR 0002). It now answers a fixed sentence and keeps the original as
 * `cause`, which stays in this process.
 */
export function toBridgeConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof BridgeFailureError) return bridgeFailure(error.code, error);
  // The domain refuses a traversal, a NUL byte or an over-long name before any
  // root is consulted, so this is the *first* of the two containment refusals
  // and the one an ordinary probe actually reaches. Its `context` carries the
  // requested path, which is why the caught error is not quoted: the caller's
  // own input coming back is how a probe learns it was understood.
  if (error instanceof AppError && error.code === 'INVALID_VIRTUAL_PATH') {
    return bridgeFailure(BridgeFailure.PATH_REJECTED, error);
  }
  // ENOENT is the ordinary answer to a path that was listed and then deleted,
  // so it is not internal -- but it is still classified here rather than
  // trusted, because only the code travels.
  if (hasSystemCode(error, 'ENOENT')) return bridgeFailure(BridgeFailure.ENTRY_NOT_FOUND, error);
  return bridgeFailure(BridgeFailure.INTERNAL, error);
}

function hasSystemCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * The router-wide guarantee that no failure leaves this process uncoded.
 *
 * Per-handler `try`/`catch` is a convention, and two handlers -- `Watch` and
 * `RevokeMaterialPlaybackGrant` -- did not follow it, so a refusal raised in
 * either arrived at the browser as Connect's own `unknown` carrying the raw
 * exception text. An interceptor is applied to every registered method,
 * including ones added later, which is the difference between an invariant and
 * a habit.
 *
 * A `ConnectError` passes through untouched: it either already carries this
 * bridge's detail, or it is Connect's own (a cancellation, a protocol error),
 * and the client derives a code from the transport status for exactly that
 * case. Anything else is classified rather than quoted.
 */
export const bridgeFailureInterceptor: Interceptor = (next) => async (request) => {
  let response;
  try {
    response = await next(request);
  } catch (error: unknown) {
    throw toBridgeConnectError(error);
  }
  // A server-streaming implementation is an async generator: calling it does
  // not run its body, so its refusals surface while the response is iterated,
  // long after `next` resolved.
  return response.stream
    ? { ...response, message: codeStreamFailures(response.message) }
    : response;
};

async function* codeStreamFailures<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
  try {
    yield* stream;
  } catch (error: unknown) {
    throw toBridgeConnectError(error);
  }
}
