export const appErrorCodes = [
  'ASSET_NOT_FOUND',
  'INVALID_SCENE',
  'INVALID_CUE',
  'INVALID_OVERRIDE',
  'FILESYSTEM_PERMISSION_DENIED',
  'FILESYSTEM_UNAVAILABLE',
  'FILE_BRIDGE_OFFLINE',
  'FILE_BRIDGE_INCOMPATIBLE',
  'MEDIA_DECODE_FAILED',
  'SCREEN_BUS_UNAVAILABLE',
  'INVALID_VIRTUAL_PATH',
  'INVALID_SNAPSHOT',
  'NATIVE_COMMAND_FAILED',
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export class AppError extends Error {
  readonly code: AppErrorCode;
  override readonly cause: unknown;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    code: AppErrorCode,
    options?: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.cause = options?.cause;
    if (options?.context !== undefined) {
      this.context = options.context;
    }
  }
}

export type Result<Value, Failure> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: Failure };

export function assertNever(value: never, context: string): never {
  throw new AppError(`Unexpected ${context}: ${String(value)}`, 'INVALID_CUE');
}
